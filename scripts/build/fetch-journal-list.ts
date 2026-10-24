/* Build-time fetch of the NLM journal-title list (issue #121).
 *
 * Usage: node --import tsx scripts/build/fetch-journal-list.ts
 *        (wired as the `prebuild` npm lifecycle hook, so every
 *        `npm run build` — and `prepack`, which calls build — refreshes it)
 *
 * Downloads the Entrez journal list
 *   https://ftp.ncbi.nlm.nih.gov/pubmed/J_Entrez.gz   (~1.9 MB gz, ~42k records,
 * regenerated daily by NLM), parses each record's JournalTitle + MedAbbr,
 * normalizes titles exactly the way the runtime query rewriter does
 * (src/entities/article/search/journal-titles.ts), and emits the surviving
 * normalized-title → NLM-abbreviation pairs as a gzipped TSV asset at
 * dist/assets/journal-titles.tsv.gz. The asset ships in the npm package
 * (package.json `files`) and is NEVER committed (dist/ is gitignored) — the
 * list is always rebuilt from the live NLM source at build time.
 *
 * Quarantine rules (entries DROPPED from the asset):
 *   1. a normalized title that maps to more than one DISTINCT MedAbbr
 *      (ambiguous — rewriting could silently change the target journal);
 *   2. a MedAbbr containing '(' (parenthetical qualifiers do not round-trip
 *      through PubMed `[Journal]` / Europe PMC `JOURNAL:"..."` field syntax).
 *
 * Failure policy — LOUD by design: transient download failures (timeouts,
 * connection resets, DNS errors, HTTP 5xx/429, truncated or corrupt gzip)
 * get 3 attempts with short escalating delays; persistent
 * failures (HTTP 4xx, unrecognized errors, format drift, exhausted retries)
 * still fail the build (exit 1) with a message naming the underlying cause,
 * because a stale or missing asset would silently disable the journal-name
 * rewrite feature — the asset is never silently stale or hollow. A
 * suspiciously small parsed row count (format drift upstream) fails the
 * build too.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const J_ENTREZ_URL = 'https://ftp.ncbi.nlm.nih.gov/pubmed/J_Entrez.gz';
/** Per-attempt download budget. Live diagnosis (2026-10-24): NCBI is
 * throttling this host to ~30 KB/s, so the ~1.9 MB payload takes 17–227.8 s
 * to transfer (median ≈60 s) — the old 60 s cap aborted roughly half of all
 * attempts before completion. 300 s covers the observed worst case with
 * headroom while still bounding a wedged transfer. */
const DOWNLOAD_TIMEOUT_MS = 300_000;
/** Retry policy for transient transport failures: up to RETRY_ATTEMPTS
 * tries, sleeping RETRY_DELAYS_MS[n-1] after failed attempt n (no delay
 * after the final attempt — it throws). HTTP 4xx and unrecognized errors
 * are NOT retried (see classifyThrownError). */
const RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 8_000];
/** Identify the script to NCBI (plain script-name UA, mirroring the
 * scripts/biowasm/pin-assets.mjs precedent; deliberately NOT importing
 * src/version.ts — the build script stays node:-only and self-contained). */
const USER_AGENT = 'biomcp-fetch-journal-list';
/** Sanity floor: the live list carries ~42k records; a parse yielding fewer
 * pairs than this means NLM changed the format (or served a truncated file)
 * and the asset must not be emitted as if it were complete. */
const MIN_PAIRS = 10_000;
const ASSET_RELATIVE_PATH = 'dist/assets/journal-titles.tsv.gz';

export interface JournalEntrezRecord {
  journalTitle: string;
  medAbbr: string;
}

/** Parse the plain-text J_Entrez format: records separated by dashed lines,
 * `Field: value` lines within (live-verified 2026-10-17: JrId /
 * JournalTitle / MedAbbr / ISSN (Print) / ISSN (Online) / IsoAbbr / NlmId).
 * Blank-line separators are tolerated too so the parser does not depend on
 * the cosmetic separator alone. */
export function parseJournalEntrezRecords(text: string): JournalEntrezRecord[] {
  const records: JournalEntrezRecord[] = [];
  // Records are separated by dashed lines (or, defensively, blank lines).
  const blocks = text.split(/\r?\n-{5,}[ \t]*\r?\n|\r?\n\s*\r?\n/);
  for (const block of blocks) {
    let journalTitle: string | undefined;
    let medAbbr: string | undefined;
    for (const rawLine of block.split(/\r?\n/)) {
      const titleMatch = rawLine.match(/^JournalTitle:[ \t](.*)$/);
      if (titleMatch) {
        journalTitle = titleMatch[1].trim();
        continue;
      }
      const abbrMatch = rawLine.match(/^MedAbbr:[ \t](.*)$/);
      if (abbrMatch) medAbbr = abbrMatch[1].trim();
    }
    if (journalTitle !== undefined && medAbbr !== undefined) {
      records.push({ journalTitle, medAbbr });
    }
  }
  return records;
}

/**
 * The SAME normalization the runtime applies to query phrases — the two
 * must stay in lockstep or lookups silently miss (casefold; strip a leading
 * article the|a|an; strip ONE trailing parenthetical; collapse whitespace).
 */
function normalizeJournalTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface JournalTitleMapBuild {
  /** normalized journal title → NLM abbreviation (MedAbbr) */
  map: Map<string, string>;
  /** number of input records dropped because their MedAbbr contains '(' */
  droppedParentheticalAbbr: number;
  /** number of normalized titles dropped for mapping to >1 distinct MedAbbr */
  droppedAmbiguousTitle: number;
}

/** Build the normalized-title → MedAbbr map from parsed records, applying
 * the two quarantine rules. Later records win for a duplicated (title,
 * abbr) pair only by overwrite-with-identical-value; conflicting abbrs
 * quarantine the key entirely. */
export function buildJournalTitleMap(records: JournalEntrezRecord[]): JournalTitleMapBuild {
  const byTitle = new Map<string, Set<string>>();
  let droppedParentheticalAbbr = 0;
  for (const { journalTitle, medAbbr } of records) {
    if (medAbbr.includes('(')) {
      droppedParentheticalAbbr++;
      continue;
    }
    const key = normalizeJournalTitle(journalTitle);
    if (!key) continue;
    let abbrs = byTitle.get(key);
    if (!abbrs) {
      abbrs = new Set<string>();
      byTitle.set(key, abbrs);
    }
    abbrs.add(medAbbr);
  }
  const map = new Map<string, string>();
  let droppedAmbiguousTitle = 0;
  for (const [key, abbrs] of byTitle) {
    if (abbrs.size > 1) {
      droppedAmbiguousTitle++;
      continue;
    }
    map.set(key, abbrs.values().next().value as string);
  }
  return { map, droppedParentheticalAbbr, droppedAmbiguousTitle };
}

/** Serialize the map as `normalizedTitle\tMedAbbr` TSV (deterministic:
 * sorted keys, so asset diffs are stable across rebuilds). */
export function journalTitleMapToTsv(map: Map<string, string>): string {
  const lines = Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([title, abbr]) => `${title}\t${abbr}`);
  return `${lines.join('\n')}\n`;
}

/** Network-class cause codes that are always worth a retry: connect/timeouts,
 * connection resets/refusals, DNS (EAI_AGAIN/ENOTFOUND), unreachable routes,
 * and undici-internal socket errors (UND_ERR_*) — mirroring the runtime
 * classifier's network set (src/connections/retry.ts NETWORK_ERROR_RE).
 * Matched against err.cause.code and the message text. */
const NETWORK_CAUSE_PATTERN = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR_/i;

/** A classified single-attempt failure. */
interface AttemptFailure {
  /** one-line summary of what went wrong (embedded verbatim in the terminal error message) */
  summary: string;
  /** most specific cause identifier available: err.cause.code, else the
   * error name / an HTTP status token — printed in logs and the throw */
  causeCodeOrName: string;
  /** the original thrown object, threaded as { cause } on the terminal
   * error (absent for HTTP-status failures, which throw nothing) */
  cause?: unknown;
  /** transient (network-class / 5xx / 429 / truncation / bad gzip) → retry;
   * anything else fails fast — never blind-retry an unknown failure class */
  retryable: boolean;
  /** appended to the terminal error message when the failure is NOT retried */
  fatalNote?: string;
}

/** Safe textual form of a thrown error. DOMException's `message` is a
 * prototype getter (stringify, never mutate or destructure it), and some
 * rejections are not Error instances at all — String() handles both. */
function describeThrown(error: unknown): string {
  return String(error);
}

/** Classify a thrown error from fetch / body-read / gunzip: key the timeout
 * detection on `.name` ('TimeoutError' — what AbortSignal.timeout rejects
 * with), network causes on `err.cause.code` or the message text; anything
 * unrecognized is FATAL (fail fast rather than retry blindly). */
function classifyThrownError(error: unknown): AttemptFailure {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  const text = describeThrown(error);
  const nested =
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  const causeCode =
    typeof nested === 'object' && nested !== null && 'code' in nested
      ? String((nested as { code: unknown }).code)
      : '';
  // Own .code only when the name is uninformative: zlib throws plain Errors
  // coded Z_DATA_ERROR, while DOMException carries a useless legacy numeric
  // code (e.g. 23) that must never shadow its .name.
  const ownCodeSource =
    typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }) : undefined;
  const ownCode = name === 'Error' && ownCodeSource?.code ? String(ownCodeSource.code) : '';
  const descriptiveName = name === 'Error' ? '' : name;
  const causeCodeOrName = causeCode || descriptiveName || ownCode || 'unknown';
  const retryable =
    name === 'TimeoutError' || NETWORK_CAUSE_PATTERN.test(causeCode) || NETWORK_CAUSE_PATTERN.test(text);
  return {
    summary: text,
    causeCodeOrName,
    cause: error,
    retryable,
    fatalNote: retryable ? undefined : 'not retryable (unrecognized failure class)',
  };
}

/** One download attempt: fetch (with UA + timeout signal) → HTTP status
 * check → body read → gunzip to text. Never throws — returns a classified
 * failure instead, so the retry loop decides retry-vs-fatal. */
async function attemptDownload(
  fetchImpl: typeof fetch
): Promise<{ ok: true; text: string } | { ok: false; failure: AttemptFailure }> {
  let response: Response;
  try {
    response = await fetchImpl(J_ENTREZ_URL, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch (error) {
    return { ok: false, failure: classifyThrownError(error) };
  }
  if (!response.ok) {
    const { status } = response;
    const retryable = status >= 500 || status === 429;
    return {
      ok: false,
      failure: {
        summary: `HTTP ${status} from ${J_ENTREZ_URL}`,
        causeCodeOrName: `HTTP_${status}`,
        retryable,
        fatalNote: retryable ? undefined : `not retryable (HTTP ${status}) — the file may have moved`,
      },
    };
  }
  let gz: Buffer;
  try {
    gz = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // A rejected body read is truncation-class (TypeError 'terminated',
    // undici socket hangs): always retryable.
    const failure = classifyThrownError(error);
    return { ok: false, failure: { ...failure, summary: `body read error (${failure.summary})`, retryable: true } };
  }
  try {
    return { ok: true, text: gunzipSync(gz).toString('utf8') };
  } catch (error) {
    // Invalid/truncated gzip: the transfer lied about completing — retry.
    const failure = classifyThrownError(error);
    return {
      ok: false,
      failure: { ...failure, summary: `invalid gzip payload (${failure.summary}) — truncated download?`, retryable: true },
    };
  }
}

export interface DownloadOptions {
  /** fetch implementation (injectable for unit tests; default: global fetch) */
  fetchImpl?: typeof fetch;
  /** sleep implementation (injectable for unit tests; default: setTimeout) */
  delayImpl?: (ms: number) => Promise<void>;
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Download + decompress the J_Entrez list, retrying transient failures per
 * the policy above. Exported and dependency-injectable so the retry /
 * classification logic is unit-testable without network access or global
 * mocks. On terminal failure throws an Error whose message embeds the last
 * attempt's summary + cause code/name (the prebuild epilogue prints only
 * `.message`) and threads the original error via `{ cause }`. */
export async function downloadJournalList(opts: DownloadOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const delayImpl = opts.delayImpl ?? defaultDelay;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const result = await attemptDownload(fetchImpl);
    if (result.ok) return result.text;
    const { summary, causeCodeOrName, cause, retryable, fatalNote } = result.failure;
    if (!retryable || attempt === RETRY_ATTEMPTS) {
      const verdict = retryable
        ? `all ${RETRY_ATTEMPTS} attempts failed (transient errors persisted)`
        : (fatalNote ?? 'not retryable');
      process.stderr.write(
        `  attempt ${attempt}/${RETRY_ATTEMPTS} failed: ${summary} (cause ${causeCodeOrName}) — ` +
          `${retryable ? 'retries exhausted' : 'fatal, not retryable'}\n`
      );
      throw new Error(
        `download failed — attempt ${attempt}/${RETRY_ATTEMPTS}: ${summary} (cause ${causeCodeOrName}); ` +
          `${verdict}. (check connectivity to ftp.ncbi.nlm.nih.gov and re-run the build)`,
        { cause }
      );
    }
    const delayMs = RETRY_DELAYS_MS[attempt - 1];
    process.stderr.write(
      `  attempt ${attempt}/${RETRY_ATTEMPTS} failed: ${summary} (cause ${causeCodeOrName}), retrying in ${delayMs}ms\n`
    );
    await delayImpl(delayMs);
  }
  // Unreachable: the final loop iteration always returns or throws.
  throw new Error(`download failed after ${RETRY_ATTEMPTS} attempts`);
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const assetPath = resolve(here, '..', '..', ASSET_RELATIVE_PATH);

  const text = await downloadJournalList();
  const records = parseJournalEntrezRecords(text);
  const { map, droppedParentheticalAbbr, droppedAmbiguousTitle } = buildJournalTitleMap(records);
  if (map.size < MIN_PAIRS) {
    throw new Error(
      `parsed only ${map.size} journal-title pairs from ${records.length} records ` +
      `(expected ≥${MIN_PAIRS}; live list carries ~42k) — the J_Entrez format likely changed; ` +
      `refusing to emit a hollow asset`
    );
  }

  const tsv = journalTitleMapToTsv(map);
  const gz = gzipSync(Buffer.from(tsv, 'utf8'));
  mkdirSync(dirname(assetPath), { recursive: true });
  writeFileSync(assetPath, gz);

  console.log(
    `journal-titles: ${records.length} NLM records → ${map.size} pairs ` +
    `(quarantined: ${droppedParentheticalAbbr} parenthetical abbrs, ` +
    `${droppedAmbiguousTitle} ambiguous titles) → ${assetPath} (${gz.length} bytes gz)`
  );
}

// Run only when executed directly (the parser/builder exports are also
// unit-tested from src/__tests__/entities/journal-titles.test.ts).
const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().catch((error: unknown) => {
    // Preserve the threaded { cause } (download failures carry the original
    // network error) instead of dropping it at the printout boundary.
    const cause = typeof error === 'object' && error !== null && 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
    const causeLine =
      cause !== undefined
        ? `\nCaused by: ${cause instanceof Error ? String(cause) : cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code: unknown }).code) : String(cause)}`
        : '';
    console.error(
      `journal-titles: FAILED — ${error instanceof Error ? error.message : String(error)}${causeLine}\n` +
      `The NLM journal list is a required build input (issue #121 journal-name rewrite); ` +
      `fix connectivity/proxy and re-run the build.`
    );
    process.exit(1);
  });
}

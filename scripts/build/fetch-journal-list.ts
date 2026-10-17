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
 * Failure policy — LOUD by design: any download failure (non-200, timeout,
 * network error) or invalid gzip fails the build (exit 1) with a retryable
 * message, because a stale or missing asset would silently disable the
 * journal-name rewrite feature. A suspiciously small parsed row count
 * (format drift upstream) fails the build too.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const J_ENTREZ_URL = 'https://ftp.ncbi.nlm.nih.gov/pubmed/J_Entrez.gz';
const DOWNLOAD_TIMEOUT_MS = 60_000;
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

async function downloadJournalList(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(J_ENTREZ_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(
      `download failed: ${error instanceof Error ? error.message : String(error)} ` +
      `(check connectivity to ftp.ncbi.nlm.nih.gov and retry)`
    );
  }
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} from ${J_ENTREZ_URL} (retryable)`);
  }
  let gz: Buffer;
  try {
    gz = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`download failed: body read error (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    return gunzipSync(gz).toString('utf8');
  } catch {
    throw new Error(`invalid gzip payload from ${J_ENTREZ_URL} (truncated download?) — retry the build`);
  }
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
    console.error(
      `journal-titles: FAILED — ${error instanceof Error ? error.message : String(error)}\n` +
      `The NLM journal list is a required build input (issue #121 journal-name rewrite); ` +
      `fix connectivity/proxy and re-run the build.`
    );
    process.exit(1);
  });
}

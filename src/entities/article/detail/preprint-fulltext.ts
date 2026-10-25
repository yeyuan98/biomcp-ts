import { TokenBucketRateLimiter } from '../../../connections/rate-limiter.js';
import { monotonicNowMs } from '../../../connections/time.js';
import { VERSION } from '../../../version.js';
import { errorMessageWithCause } from '../../errors.js';
import { isPreprintDoi } from './id-resolution.js';
import {
  fetchOfficialDetails,
  normalizeServer,
  splitSemicolonAuthors,
  type BiorxivDetailsRecord,
} from './preprint.js';
import { cleanArticleTitle } from '../europepmc-shared.js';
import {
  applyCharBudget,
  extractJatsSections,
  FULLTEXT_DEFAULT_MAX_CHARS,
  FULLTEXT_MAX_CHARS_LIMIT,
  type ExtractedJats,
  type FullTextSection,
} from './fulltext.js';
import { licenseToUrl } from './open-access.js';
import type { OutlineEntry } from './fulltext-store.js';
import {
  latestCachedVersion,
  readPreprintFullText,
  writePreprintFullText,
  type PreprintFullTextReadResult,
} from './preprint-fulltext-cache.js';

/**
 * On-demand bioRxiv/medRxiv full-text fetch (issue #44).
 *
 * www.biorxiv.org (and www.medrxiv.org) sit behind Cloudflare and start
 * rejecting automated JATS downloads quickly (HTTP 429 "error code: 1015"
 * under light repetition — empirically verified, see the issue), while
 * api.biorxiv.org is friendly. Therefore:
 *
 * - record resolution goes through the official api.biorxiv.org connection
 *   (shared, 1 req/s, retried) exactly like the article_get preprint path;
 * - the JATS download is RAW fetch (the shared rest connection cannot
 *   honor Retry-After), spaced ≥3 s by a module-singleton token bucket,
 *   with at most ONE retry on transient errors and a hard ≥60 s cooldown
 *   (Retry-After honored when larger) after any 429/403/1015 verdict;
 * - downloads are strictly on-demand — nothing here runs during search;
 * - every success is cached per (doi, version) — JATS per version is
 *   immutable — and the cache is read BEFORE any download.
 *
 * The envelope mirrors article_get's fulltext shapes (available file/inline,
 * honest unavailable reasons) so agents transfer their existing mental
 * model; doi/version/license/license_url always ride along so reuse terms
 * are visible wherever the text goes.
 */

export type PreprintFullTextStatus = 'available' | 'unavailable';
export type PreprintFullTextReason = 'not_found' | 'no_jats_xml' | 'rate_limited' | 'fetch_failed';

export interface PreprintFullTextLinks {
  doi_url?: string;
  jatsxml_url?: string;
}

export interface PreprintFullTextResult {
  status: PreprintFullTextStatus;
  reason?: PreprintFullTextReason;
  doi: string;
  /** 'bioRxiv' | 'medRxiv' once resolved */
  server?: string;
  /** Resolved preprint version (latest when the caller did not pin one). */
  version?: number;
  title?: string;
  authors?: string[];
  /** Normalized display form ('cc by-nc-nd') when it maps to a CC URL;
   * verbatim upstream value otherwise. */
  license?: string;
  license_url?: string;
  source: 'biorxiv_jats';
  /** 'file' (default): body on disk, reply carries file_path + outline.
   *  'inline': body is in sections[]. Unavailable results carry neither. */
  mode?: 'file' | 'inline';
  format?: 'markdown' | 'jats-xml';
  /** file mode only: markdown cache file with the complete text */
  file_path?: string;
  /** file mode only: navigation for selective Read/Grep (line numbers are
   *  exact for the written file) */
  outline?: OutlineEntry[];
  sections?: FullTextSection[];
  char_count?: number;
  total_char_count?: number;
  /** Inline-mode cap (0 = no cap applies, i.e. file mode). */
  max_chars: number;
  truncated?: boolean;
  omitted_sections?: string[];
  /** True when served from the (doi, version) disk cache — no download. */
  cached?: boolean;
  /** rate_limited only: seconds until downloads are attempted again. */
  retry_after_sec?: number;
  links?: PreprintFullTextLinks;
  note: string;
}

export interface PreprintFullTextOptions {
  /** Pin a specific preprint version; default = latest from /details. */
  version?: number;
  /** 'file' (default): write/serve the markdown cache file, return a
   *  handle. 'inline': return capped text sections in the reply. */
  output?: 'file' | 'inline';
  /** Inline-mode char cap (default 40000, limit 200000). */
  maxChars?: number;
}

/** Tool-level timeout budget the preprint_fulltext tool schedules against
 * (server/tools/article.ts). Worst case: /details ~31 s (shared-connection
 * transport failure) + 3 s limiter + 2 × 30 s download attempts + 1 s
 * backoff ≈ 95 s; 120 s leaves serialization margin. Mirrors the
 * patent-search budget precedent. */
export const PREPRINT_FULLTEXT_TOOL_BUDGET_MS = 120_000;

/** ≥3 s minimum spacing between www.biorxiv.org/www.medrxiv.org requests. */
const DOWNLOAD_INTERVAL_MS = 3000;
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 30_000;
/** One attempt + ONE bounded retry on transient errors only — a 429/403
 * verdict is final (retrying a rate limit would hammer the host; live
 * 2026-10 verification: 3 www-host requests/minute already trip a
 * Cloudflare 1015 429 with retry-after 8s). The #210 connect-phase
 * failures that looked retry-worthy were fixed at the dispatcher layer
 * (#212), so the attempt count deliberately stays at 2. */
const DOWNLOAD_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1000;
/** Hard cooldown floor after any rate-limit verdict; Retry-After wins
 * when larger. */
const MIN_COOLDOWN_MS = 60_000;
/** Safety valve for unbounded external input. */
const MAX_JATS_CHARS = 20_000_000;

let downloadLimiter = new TokenBucketRateLimiter({ intervalMs: DOWNLOAD_INTERVAL_MS });
let cooldownUntil = 0;

/** Test/maintenance hook: clears the cooldown and re-arms the download
 * limiter. Production code never calls this. */
export function resetPreprintDownloadGate(): void {
  downloadLimiter = new TokenBucketRateLimiter({ intervalMs: DOWNLOAD_INTERVAL_MS });
  cooldownUntil = 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Cloudflare rate-limit verdicts arrive as 429 (body: "error code: 1015")
 * or 403; a challenge page can also sneak through with HTTP 200. */
const RATE_LIMIT_BODY_RE = /error code:\s*1015|Just a moment\.\.\./i;

/** api.biorxiv.org /details carries underscore license forms (cc_by,
 * cc_by_nc_nd, na); the shared CC lookup (open-access.ts licenseToUrl)
 * keys on display forms ('cc by-nc-nd'). Normalize for the lookup; when
 * nothing maps (na, unknown), fall back to the verbatim value + no URL. */
function normalizeLicense(raw?: string): { license?: string; license_url?: string } {
  if (!raw) return {};
  const parts = raw.toLowerCase().split('_');
  const display = parts.length > 1 ? `${parts[0]} ${parts.slice(1).join('-')}` : parts[0];
  const url = licenseToUrl(display);
  if (url) return { license: display, license_url: url };
  return { license: raw };
}

function licenseNote(license?: string): string {
  if (!license) return '';
  if (license.toLowerCase() === 'na') {
    return ' License "na" (no CC license declared) — reuse may be restricted; check the preprint page (links.doi_url).';
  }
  return ' The per-article license governs reuse of this text.';
}

function referencesNote(hasReferences?: boolean): string {
  return hasReferences
    ? ' The reference list is omitted; use article_get with sections=["citation"] (backward mode) on the preprint DOI for the references.'
    : '';
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Enter (or extend) the cooldown; returns the effective remaining ms. */
function enterCooldown(retryAfterMs?: number): number {
  const duration = Math.max(MIN_COOLDOWN_MS, retryAfterMs ?? 0);
  const until = monotonicNowMs() + duration;
  if (until > cooldownUntil) cooldownUntil = until;
  return Math.max(duration, cooldownUntil - monotonicNowMs());
}

/** Only the two known CSHL preprint hosts may be downloaded from — a
 * crafted /details payload must not steer fetches elsewhere. */
function isAllowedDownloadHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)biorxiv\.org$/.test(u.hostname) || /(^|\.)medrxiv\.org$/.test(u.hostname);
  } catch {
    return false;
  }
}

type DownloadOutcome =
  | { kind: 'ok'; xml: string }
  | { kind: 'rate_limited'; cooldownMs: number }
  | { kind: 'gone' }
  | { kind: 'failed'; detail: string };

async function downloadJats(url: string): Promise<DownloadOutcome> {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    await downloadLimiter.acquire();
    // A concurrent call may have tripped the cooldown while we waited for
    // the limiter — never start an attempt inside a cooldown.
    if (monotonicNowMs() < cooldownUntil) {
      return { kind: 'rate_limited', cooldownMs: cooldownUntil - monotonicNowMs() };
    }
    let resp: Response;
    try {
      resp = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_ATTEMPT_TIMEOUT_MS),
        headers: {
          Accept: 'application/xml, text/xml',
          'User-Agent': `biomcp-ts/${VERSION} (https://github.com/yeyuan98/biomcp-ts)`,
        },
      });
    } catch (error) {
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      // Fallback chain so the detail is never empty (#132): some rejections
      // carry no message at all (DOMException variants, empty-message
      // errors) — fall back to the cause signal, then the error name, then
      // String() as the last resort.
      const name = (error as { name?: unknown } | null | undefined)?.name;
      const msg =
        errorMessageWithCause(error) ||
        (typeof name === 'string' && name ? name : '') ||
        String(error);
      return { kind: 'failed', detail: `network/timeout after ${attempt} attempts (${msg})` };
    }
    if (resp.status === 429 || resp.status === 403) {
      // The verdict is final: no retry, cool down, report honestly.
      void resp.body?.cancel().catch(() => undefined);
      const cooldownMs = enterCooldown(parseRetryAfterMs(resp.headers));
      return { kind: 'rate_limited', cooldownMs };
    }
    if (resp.status === 404) {
      return { kind: 'gone' };
    }
    if (!resp.ok) {
      if (resp.status >= 500 && attempt < DOWNLOAD_ATTEMPTS) {
        await sleep(RETRY_BACKOFF_MS);
        continue;
      }
      return { kind: 'failed', detail: `HTTP ${resp.status} from the preprint host` };
    }
    const text = await resp.text();
    if (text.length > MAX_JATS_CHARS) {
      return { kind: 'failed', detail: `payload too large (${text.length} chars)` };
    }
    // Cloudflare challenge/1015 pages carry their markers in the first KB; a
    // legitimate JATS body can contain the phrase in prose, so never scan deeper.
    if (RATE_LIMIT_BODY_RE.test(text.slice(0, 1024))) {
      const cooldownMs = enterCooldown(undefined);
      return { kind: 'rate_limited', cooldownMs };
    }
    return { kind: 'ok', xml: text };
  }
  return { kind: 'failed', detail: 'download attempts exhausted' };
}

// ---------------------------------------------------------------------------
// Envelope builders (mirror fulltext.ts shapes)
// ---------------------------------------------------------------------------

const S3_NOTE = 'For corpus-scale text mining, bioRxiv/medRxiv publish monthly S3 requester-pays buckets (s3://biorxiv-src-monthly, s3://medrxiv-src-monthly; terms: https://www.biorxiv.org/tdm).';

function unavailableNote(reason: PreprintFullTextReason): string {
  switch (reason) {
    case 'not_found':
      return 'No preprint record/JATS was found for this identifier or version; verify the DOI/version against the article_get reply (preprint.versions lists what exists).';
    case 'no_jats_xml':
      return 'This version has no machine-readable JATS full text (the /details record carries no jatsxml URL). Retrying will not help; try another version or use the abstract via article_get.';
    case 'rate_limited':
      return `www.biorxiv.org is rate-limiting JATS downloads (Cloudflare 429/1015). Downloads are paused for the reported cooldown (Retry-After honored, ${MIN_COOLDOWN_MS / 1000}s floor); re-call after the pause. ${S3_NOTE}`;
    case 'fetch_failed':
      return 'The fetch failed at the network/transport level; this may be transient — one retry is reasonable.';
  }
}

function buildUnavailable(args: {
  doi: string;
  reason: PreprintFullTextReason;
  maxChars: number;
  version?: number;
  server?: string;
  title?: string;
  license?: string;
  license_url?: string;
  jatsxml_url?: string;
  retry_after_sec?: number;
  detail?: string;
}): PreprintFullTextResult {
  const note = [unavailableNote(args.reason), args.detail].filter(Boolean).join(' ');
  return {
    status: 'unavailable',
    reason: args.reason,
    doi: args.doi,
    server: args.server,
    version: args.version,
    title: args.title,
    license: args.license,
    license_url: args.license_url,
    source: 'biorxiv_jats',
    max_chars: args.maxChars,
    retry_after_sec: args.retry_after_sec,
    links: {
      doi_url: `https://doi.org/${args.doi}`,
      jatsxml_url: args.jatsxml_url,
    },
    note,
  };
}

interface CacheHitExtra {
  /** Disclosure appended to the note (e.g. cooldown-served). */
  noteExtra?: string;
}

function serveCacheHit(
  hit: Extract<PreprintFullTextReadResult, { ok: true }>,
  output: 'file' | 'inline',
  maxChars: number,
  extra: CacheHitExtra
): PreprintFullTextResult {
  const meta = hit.meta;
  const links = { doi_url: `https://doi.org/${meta.doi}`, jatsxml_url: meta.jatsxml_url };
  const refs = referencesNote(meta.has_references);
  const lic = licenseNote(meta.license);
  const cacheLine = ' Cached copy (per (doi, version) — JATS per version is immutable, so re-calls do not download).';
  const base = {
    doi: meta.doi,
    server: meta.server,
    version: meta.version,
    title: meta.title,
    authors: meta.authors,
    license: meta.license,
    license_url: meta.license_url,
    source: 'biorxiv_jats' as const,
    cached: true,
    links,
  };

  if (output === 'file') {
    const trunc = meta.truncated
      ? ` File truncated at the 2,000,000-char safety cap; omitted: ${meta.omitted_sections?.join(', ')}.`
      : '';
    return {
      ...base,
      status: 'available',
      mode: 'file',
      format: 'markdown',
      file_path: hit.file_path,
      outline: hit.outline,
      char_count: meta.char_count,
      total_char_count: meta.total_char_count,
      truncated: meta.truncated,
      omitted_sections: meta.omitted_sections,
      max_chars: 0,
      note: `Full text is in the cached file above (markdown; each section starts with "## <heading>" at the outline line numbers — Read/Grep selectively).${cacheLine}${trunc}${refs}${lic}${extra.noteExtra ?? ''}`,
    };
  }

  const parsed = applyCharBudget(
    { sections: hit.sections, total_char_count: meta.total_char_count, hasReferences: meta.has_references ?? false },
    maxChars
  );
  const notes: string[] = [];
  if (parsed.truncated) {
    const omitted = parsed.omitted_sections?.length ? `; omitted: ${parsed.omitted_sections.join(', ')}` : '';
    notes.push(`Truncated at ${parsed.char_count} of ${parsed.total_char_count} chars${omitted}. Re-call with fulltext_max_chars=${FULLTEXT_MAX_CHARS_LIMIT} for the complete text, or output="file" for the cached full document.`);
  }
  if (refs) notes.push(refs.trim());
  if (lic) notes.push(lic.trim());
  if (!notes.length) notes.push('Complete text.');
  return {
    ...base,
    status: 'available',
    mode: 'inline',
    format: 'jats-xml',
    max_chars: maxChars,
    sections: parsed.sections,
    char_count: parsed.char_count,
    total_char_count: parsed.total_char_count,
    truncated: parsed.truncated,
    omitted_sections: parsed.omitted_sections,
    note: `${notes.join(' ')}${cacheLine}${extra.noteExtra ?? ''}`,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function fetchPreprintFullText(
  doi: string,
  options: PreprintFullTextOptions = {}
): Promise<PreprintFullTextResult> {
  const maxChars = Math.max(1000, Math.min(options.maxChars ?? FULLTEXT_DEFAULT_MAX_CHARS, FULLTEXT_MAX_CHARS_LIMIT));
  const output = options.output ?? 'file';
  const trimmed = doi.trim();

  if (!isPreprintDoi(trimmed)) {
    throw new Error(
      `"${doi}" is not a bioRxiv/medRxiv preprint DOI (expected 10.1101/YYYY.MM.DD.NNNNNN or 10.64898/...). ` +
      'Use article_get for journal articles; preprint_fulltext serves bioRxiv/medRxiv preprints only.'
    );
  }
  if (options.version !== undefined && (!Number.isInteger(options.version) || options.version < 1)) {
    throw new Error(`version must be a positive integer (got ${options.version}).`);
  }

  // 1. Explicit-version requests can be served with ZERO network: the
  // cached copy for that exact (doi, version) is immutable.
  if (options.version !== undefined) {
    const hit = readPreprintFullText(trimmed, options.version);
    if (hit.ok) return serveCacheHit(hit, output, maxChars, {});
  }

  // 2. Cooldown gate: while paused, return immediately (or serve whatever
  // is already cached — for default-version calls the newest cached
  // version, disclosed in the note). Never sleep past a budget.
  const cooldownRemainingMs = cooldownUntil - monotonicNowMs();
  if (cooldownRemainingMs > 0) {
    const cachedVersion = options.version ?? latestCachedVersion(trimmed);
    if (cachedVersion !== undefined) {
      const hit = readPreprintFullText(trimmed, cachedVersion);
      if (hit.ok) {
        return serveCacheHit(hit, output, maxChars, {
          noteExtra: ` Served from cache: a download cooldown is active (${Math.ceil(cooldownRemainingMs / 1000)}s remaining), so the live latest version was not checked.`,
        });
      }
    }
    return buildUnavailable({
      doi: trimmed,
      reason: 'rate_limited',
      maxChars,
      version: options.version,
      retry_after_sec: Math.ceil(cooldownRemainingMs / 1000),
    });
  }

  // 3. Resolve the record on the friendly official API (both server
  // collections probed, mirroring the article_get preprint path).
  const details = await fetchOfficialDetails(trimmed);
  if (details.kind === 'unreachable') {
    return buildUnavailable({
      doi: trimmed,
      reason: 'fetch_failed',
      maxChars,
      version: options.version,
      detail: 'api.biorxiv.org (record resolution) is unreachable.',
    });
  }
  if (details.kind === 'not_found') {
    return buildUnavailable({
      doi: trimmed,
      reason: 'not_found',
      maxChars,
      version: options.version,
      detail: 'Both the biorxiv and medrxiv collections answered "no posts found" for this DOI. Find the right preprint via article_search with source="preprint_only".',
    });
  }

  // 4. Pick the record: the requested version, else the latest.
  const byVersion = new Map<number, BiorxivDetailsRecord>();
  for (const r of details.records) {
    const v = Number(r.version);
    if (Number.isFinite(v)) byVersion.set(v, r);
  }
  const versions = [...byVersion.keys()].sort((a, b) => a - b);
  const wanted = options.version ?? versions[versions.length - 1];
  const record = wanted === undefined ? undefined : byVersion.get(wanted);
  if (!record) {
    return buildUnavailable({
      doi: trimmed,
      reason: 'not_found',
      maxChars,
      detail: `Version ${options.version} is not among the available versions [${versions.join(', ') || 'none'}] for this DOI.`,
    });
  }
  const version = wanted as number;
  const serverLabel = normalizeServer(record.server ?? details.server);
  const meta = {
    doi: record.doi || trimmed,
    title: cleanArticleTitle(record.title),
    authors: splitSemicolonAuthors(record.authors),
    ...normalizeLicense(record.license),
  };

  // 5. Read-before-download (default-version path).
  const cached = readPreprintFullText(meta.doi, version);
  if (cached.ok) return serveCacheHit(cached, output, maxChars, {});

  const jatsUrl = record.jatsxml;
  if (!jatsUrl) {
    return buildUnavailable({
      ...meta,
      doi: meta.doi,
      server: serverLabel,
      version,
      reason: 'no_jats_xml',
      maxChars,
      detail: `Version ${version} carries no jatsxml URL. Available versions: [${versions.join(', ')}].`,
    });
  }
  if (!isAllowedDownloadHost(jatsUrl)) {
    return buildUnavailable({
      ...meta,
      doi: meta.doi,
      server: serverLabel,
      version,
      reason: 'fetch_failed',
      maxChars,
      detail: 'The record\u2019s jatsxml URL points at an unexpected host — refused defensively.',
    });
  }

  // 6. Gated download (3s spacing, one bounded retry, cooldown on 429/403).
  const dl = await downloadJats(jatsUrl);
  if (dl.kind === 'rate_limited') {
    return buildUnavailable({
      ...meta,
      doi: meta.doi,
      server: serverLabel,
      version,
      jatsxml_url: jatsUrl,
      reason: 'rate_limited',
      maxChars,
      retry_after_sec: Math.ceil(dl.cooldownMs / 1000),
    });
  }
  if (dl.kind === 'gone') {
    return buildUnavailable({
      ...meta,
      doi: meta.doi,
      server: serverLabel,
      version,
      jatsxml_url: jatsUrl,
      reason: 'not_found',
      maxChars,
      detail: `The preprint host returned 404 for version ${version}'s JATS URL.`,
    });
  }
  if (dl.kind === 'failed') {
    return buildUnavailable({
      ...meta,
      doi: meta.doi,
      server: serverLabel,
      version,
      jatsxml_url: jatsUrl,
      reason: 'fetch_failed',
      maxChars,
      detail: `JATS download failed (${dl.detail}) from ${jatsUrl}. Retry once; if it persists, use article_get (abstract) or the DOI landing page.`,
    });
  }

  // 7. Parse (host-agnostic JATS parser shared with the PMC path).
  const extracted: ExtractedJats | null = extractJatsSections(dl.xml);
  if (!extracted) {
    return buildUnavailable({
      ...meta,
      doi: meta.doi,
      server: serverLabel,
      version,
      jatsxml_url: jatsUrl,
      reason: 'no_jats_xml',
      maxChars,
      detail: 'The downloaded document carries no machine-readable <article>/<body>.',
    });
  }

  // 8. Cache the immutable (doi, version) copy, then serve.
  const write = writePreprintFullText({
    doi: meta.doi,
    version,
    server: serverLabel,
    title: meta.title,
    authors: meta.authors,
    license: meta.license,
    license_url: meta.license_url,
    jatsxml_url: jatsUrl,
    hasReferences: extracted.hasReferences,
    sections: extracted.sections,
  });

  const links = { doi_url: `https://doi.org/${meta.doi}`, jatsxml_url: jatsUrl };
  const refs = referencesNote(extracted.hasReferences);
  const lic = licenseNote(meta.license);

  if (output === 'file' && write.ok) {
    const trunc = write.truncated
      ? ` File truncated at the 2,000,000-char safety cap; omitted: ${write.omitted_sections?.join(', ')}.`
      : '';
    return {
      status: 'available',
      mode: 'file',
      doi: meta.doi,
      server: serverLabel,
      version,
      title: meta.title,
      authors: meta.authors,
      license: meta.license,
      license_url: meta.license_url,
      source: 'biorxiv_jats',
      format: 'markdown',
      file_path: write.file_path,
      outline: write.outline,
      char_count: write.char_count,
      total_char_count: write.total_char_count,
      truncated: write.truncated,
      omitted_sections: write.omitted_sections,
      max_chars: 0,
      cached: false,
      links,
      note: `Full text is in the file above (markdown; each section starts with "## <heading>" at the outline line numbers — Read/Grep selectively). The copy is now cached per (doi, version) — JATS per version is immutable, so re-calls do not download.${trunc}${refs}${lic}`,
    };
  }
  if (output === 'file' && !write.ok) {
    // Cache trouble must never lose the text: fall back to inline at the
    // default cap, disclosed in the note (mirrors fulltext.ts).
    console.error('[preprint-fulltext] cache write failed, falling back to inline:', write.reason);
  }

  const effectiveMax = !write.ok && output === 'file'
    ? Math.min(maxChars, FULLTEXT_DEFAULT_MAX_CHARS)
    : maxChars;
  const parsed = applyCharBudget(extracted, effectiveMax);
  const notes: string[] = [];
  if (parsed.truncated) {
    const omitted = parsed.omitted_sections?.length ? `; omitted: ${parsed.omitted_sections.join(', ')}` : '';
    notes.push(`Truncated at ${parsed.char_count} of ${parsed.total_char_count} chars${omitted}. Re-call with fulltext_max_chars=${FULLTEXT_MAX_CHARS_LIMIT} for the complete text.`);
  }
  if (refs) notes.push(refs.trim());
  if (lic) notes.push(lic.trim());
  if (!notes.length) notes.push('Complete text.');
  const fallbackNote = !write.ok && output === 'file'
    ? ` (File output was requested but the cache write failed — returning inline text instead: ${write.reason}.)`
    : '';
  return {
    status: 'available',
    mode: 'inline',
    doi: meta.doi,
    server: serverLabel,
    version,
    title: meta.title,
    authors: meta.authors,
    license: meta.license,
    license_url: meta.license_url,
    source: 'biorxiv_jats',
    format: 'jats-xml',
    max_chars: effectiveMax,
    sections: parsed.sections,
    char_count: parsed.char_count,
    total_char_count: parsed.total_char_count,
    truncated: parsed.truncated,
    omitted_sections: parsed.omitted_sections,
    cached: false,
    links,
    note: `${notes.join(' ')}${fallbackNote}`,
  };
}

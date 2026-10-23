/* Journal-metrics lookup against OpenAlex /sources (journal_metrics tool).
 *
 * OpenAlex is the open alternative to Clarivate's Journal Citation Reports:
 * per-journal 2-year mean citedness (an impact-factor-style score), h-index,
 * i10-index, citation counts, OA flags, and quality-list tiers (medline,
 * norway-2, jufo-3…). Three query modes:
 *
 *  1. ISSN (regex-dected) — exact `filter=issn:` lookup, one hit.
 *  2. NLM abbreviation — expanded to the full title via the bundled NLM
 *     journal-title list (inverted map), disclosed in `warnings`.
 *  3. Any other name — `search=` full-text search.
 *
 * Hygiene: OpenAlex occasionally serves multiple zombie records for the same
 * journal (duplicate ingestion); same-display_name groups are collapsed to
 * the best record (highest 2yr mean citedness, then works_count) with a
 * disclosure warning. Responses are cached for 24h keyed by the exact
 * request path — journal metrics move at most daily, and the keyless
 * OpenAlex budget is $0.10/day per IP.
 */
import { connectionManager } from '../../connections/manager.js';
import { HttpConnectionError } from '../../connections/errors.js';
import { monotonicNowMs } from '../../connections/time.js';
import { getJournalAbbreviationMap, normalizeJournalPhrase } from '../article/search/journal-titles.js';
import type { JournalMetrics, JournalMetricsCount, JournalMetricsError, JournalMetricsResult } from './types.js';

/** ISSN shape: 4 digits, dash, 3 digits, 1 digit-or-X (case-insensitive). */
const ISSN_RE = /^\d{4}-\d{3}[\dX]$/i;

/**
 * Exact `select` list sent on every request: pins the payload shape (and
 * keeps responses small). The transform tolerates any of these being
 * absent/null upstream.
 */
const SELECT_FIELDS =
  'id,display_name,alternate_titles,issn,issn_l,type,is_oa,is_in_doaj,is_core,homepage_url,works_count,cited_by_count,summary_stats,counts_by_year,listed_in';

/** Response cache TTL: journal metrics change at most daily (OpenAlex
 * refreshes incrementally), and repeat lookups are the common case (agents
 * scoring journals across many articles). */
const JOURNAL_METRICS_TTL_MS = 86_400_000;

/** Cache entry cap. Simple insertion-order eviction (oldest first) is
 * enough: entries all share one TTL, so insertion order approximates
 * expiry order. */
const JOURNAL_METRICS_CACHE_MAX = 500;

interface JournalMetricsCacheEntry {
  expiresAtMs: number;
  json: unknown;
}

const journalMetricsCache = new Map<string, JournalMetricsCacheEntry>();

/** Drop every cached OpenAlex /sources response (test seam; also lets a
 * long-lived process force a refresh after a midnight-UTC budget reset). */
export function clearJournalMetricsCache(): void {
  journalMetricsCache.clear();
}

/** Fetch (or serve from cache) one OpenAlex /sources response. The cache
 * stores the RAW parsed JSON before any transform, keyed by the full
 * request path+query actually sent — so preprocessing warnings (e.g.
 * abbreviation expansion) still derive from the per-call query, while
 * zombie/zero-hit warnings re-derive on each transform (acceptable
 * repetition for the 24h TTL). */
async function fetchSources(path: string, signal?: AbortSignal): Promise<unknown> {
  const now = monotonicNowMs();
  const cached = journalMetricsCache.get(path);
  if (cached) {
    if (cached.expiresAtMs > now) return cached.json;
    journalMetricsCache.delete(path); // expired
  }

  const conn = connectionManager.getConnection('openalex');
  const json = await conn.request(path, undefined, { signal });

  // Re-insert (delete first) so a refresh moves the key to the back of the
  // insertion-order eviction queue.
  journalMetricsCache.delete(path);
  journalMetricsCache.set(path, { expiresAtMs: monotonicNowMs() + JOURNAL_METRICS_TTL_MS, json });
  while (journalMetricsCache.size > JOURNAL_METRICS_CACHE_MAX) {
    const oldest = journalMetricsCache.keys().next().value;
    if (oldest === undefined) break;
    journalMetricsCache.delete(oldest);
  }
  return json;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === 'string');
}

/** Sort/trim/normalize one raw counts_by_year array: keep entries that
 * carry a year, newest first, at most 10 rows (OpenAlex serves them in
 * arbitrary order and occasionally more than a decade). */
function transformCountsByYear(raw: unknown): JournalMetricsCount[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as { year?: unknown }).year === 'number')
    .sort((a, b) => (b.year as number) - (a.year as number))
    .slice(0, 10)
    .map((c) => ({
      year: c.year as number,
      works_count: asNumber(c.works_count) ?? 0,
      cited_by_count: asNumber(c.cited_by_count) ?? 0,
    }));
}

/** Map one raw OpenAlex source record to the public shape. `id` is a full
 * URL (https://openalex.org/S…); the short suffix is the canonical
 * openalex_id. `summary_stats` becomes null when absent upstream — an
 * honest "no data" rather than an omitted field. */
function transformSource(raw: unknown): JournalMetrics {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const idUrl = asString(rec.id) ?? '';
  const openalexId = idUrl.split('/').filter(Boolean).pop() ?? idUrl;

  const stats = rec.summary_stats as Record<string, unknown> | null | undefined;
  let summaryStats: JournalMetrics['summary_stats'];
  if (stats && typeof stats === 'object') {
    summaryStats = {
      two_year_mean_citedness: asNumber(stats['2yr_mean_citedness']) ?? 0,
      h_index: asNumber(stats.h_index) ?? 0,
      i10_index: asNumber(stats.i10_index) ?? 0,
    };
  } else {
    summaryStats = null;
  }

  const out: JournalMetrics = {
    openalex_id: openalexId,
    source: 'openalex',
    display_name: asString(rec.display_name) ?? '',
    summary_stats: summaryStats,
  };
  const optional: Array<[keyof JournalMetrics, unknown]> = [
    ['alternate_titles', asStringArray(rec.alternate_titles)],
    ['issn_l', asString(rec.issn_l)],
    ['issn', asStringArray(rec.issn)],
    ['type', asString(rec.type)],
    ['is_oa', asBoolean(rec.is_oa)],
    ['is_in_doaj', asBoolean(rec.is_in_doaj)],
    ['is_core', asBoolean(rec.is_core)],
    ['homepage_url', asString(rec.homepage_url)],
    ['works_count', asNumber(rec.works_count)],
    ['cited_by_count', asNumber(rec.cited_by_count)],
    ['counts_by_year', transformCountsByYear(rec.counts_by_year)],
    ['listed_in', asStringArray(rec.listed_in)],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Zombie-record ranking: higher 2yr mean citedness wins (0 for missing);
 * on a tie (including both-zero), higher works_count wins. */
function zombieRank(r: JournalMetrics): number {
  return (r.summary_stats?.two_year_mean_citedness ?? 0) * 1e12 + (r.works_count ?? 0);
}

/** Collapse same-display_name groups (casefolded) to the best record,
 * warning about every suppressed openalex_id — OpenAlex's duplicate
 * ingestion otherwise serves stale zombie sources alongside the live one. */
function suppressZombieDuplicates(results: JournalMetrics[], warnings: string[]): JournalMetrics[] {
  const groups = new Map<string, JournalMetrics[]>();
  for (const r of results) {
    const key = r.display_name.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  if (groups.size === results.length) return results; // all unique — fast path

  const kept: JournalMetrics[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => zombieRank(b) - zombieRank(a));
    const best = sorted[0];
    kept.push(best);
    warnings.push(
      `Duplicate OpenAlex records for '${best.display_name}'; showing ${best.openalex_id} ` +
        `(suppressed: ${sorted.slice(1).map((r) => r.openalex_id).join(', ')}).`
    );
  }
  return kept;
}

/** Duck-typed HttpConnectionError probe: instanceof alone can false-fail
 * across Jest vm realms, while the typed fields stay readable. */
function httpErrorStatus(error: unknown): number | undefined {
  if (error instanceof HttpConnectionError) return error.status;
  const e = error as { name?: unknown; status?: unknown } | null | undefined;
  if (e && typeof e === 'object' && e.name === 'HttpConnectionError' && typeof e.status === 'number') {
    return e.status;
  }
  return undefined;
}

/** Map any thrown value to the envelope's error shape. OpenAlex's keyless
 * tier shares a global $0.10/day budget per IP: a 429 whose body names the
 * budget/daily spend is terminal for the day (retrying cannot help, but a
 * free OPENALEX_API_KEY raises it to a private $1/day quota); every other
 * 429 is the per-second throttle. Timeouts/network errors stay retryable
 * via the typed HttpConnectionError.retryable classification. */
function mapOpenAlexError(error: unknown): JournalMetricsError {
  const message = error instanceof Error ? error.message : String(error);
  const status = httpErrorStatus(error);
  if (status === 429) {
    if (/budget|daily|usd|\$/i.test(message)) {
      return {
        source: 'openalex',
        message:
          'OpenAlex daily budget exhausted for this IP — set OPENALEX_API_KEY (free, $1/day) to get a private quota; resets midnight UTC.',
        retryable: false,
      };
    }
    return {
      source: 'openalex',
      message: `OpenAlex rate limited (per-second throttle) — wait a moment and retry shortly. (${message})`,
      retryable: true,
    };
  }
  const typedRetryable = (error as { retryable?: unknown } | null | undefined)?.retryable;
  return {
    source: 'openalex',
    message,
    retryable: typeof typedRetryable === 'boolean' ? typedRetryable : true,
  };
}

export interface JournalMetricsOptions {
  /** Max results for NAME searches (default 5). Exact ISSN lookups ignore
   * it — OpenAlex returns the single matching source. */
  limit?: number;
  /** AbortSignal threaded into the connection layer (tool deadline/client
   * cancellation). */
  signal?: AbortSignal;
}

/**
 * Look up journal quality metrics from OpenAlex /sources by journal name,
 * NLM abbreviation, or ISSN. Never throws for upstream failures — they ride
 * in the envelope's `errors` channel; only programming errors reject.
 */
export async function lookupJournalMetrics(
  query: string,
  opts?: JournalMetricsOptions,
): Promise<JournalMetricsResult> {
  const warnings: string[] = [];
  try {
    const q = query.trim();
    const limit = opts?.limit ?? 5;

    let path: string;
    if (ISSN_RE.test(q)) {
      path = `sources?filter=issn:${q.toUpperCase()}&select=${SELECT_FIELDS}`;
    } else {
      const normalized = normalizeJournalPhrase(q);
      const expanded = getJournalAbbreviationMap().get(normalized);
      let searchTerm = normalized;
      if (expanded && expanded !== normalized) {
        searchTerm = expanded;
        warnings.push(`Journal abbreviation expanded: '${q}' → '${expanded}' (NLM).`);
      }
      path = `sources?search=${encodeURIComponent(searchTerm)}&per-page=${limit}&select=${SELECT_FIELDS}`;
    }

    const json = await fetchSources(path, opts?.signal);
    const rawResults =
      (json && typeof json === 'object' ? (json as { results?: unknown }).results : undefined) ?? [];
    const results = suppressZombieDuplicates(
      (Array.isArray(rawResults) ? rawResults : []).map(transformSource),
      warnings,
    );
    if (results.length === 0) {
      warnings.push('No journal matched — try the exact journal title or its ISSN.');
    }
    return { results, warnings, errors: [] };
  } catch (error) {
    return { results: [], warnings, errors: [mapOpenAlexError(error)] };
  }
}

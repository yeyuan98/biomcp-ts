// arXiv Atom Query API — https://export.arxiv.org/api/query (legacy API,
// stable for ~15 years; watch https://info.arxiv.org/help/api/ and the
// arxiv-api mailing list for breaking changes). Terms of Use
// (https://info.arxiv.org/help/api/tou.html) cap clients at 1 request per
// 3 seconds on a single connection, aggregated across ALL machines under
// the operator's control — the 'arxiv' registry entry enforces the 3 s
// spacing client-side per process (capacity-1 token bucket; retry
// attempts: 2 = one polite re-acquiring retry). arXiv offers NO API keys;
// an HTTP 403 here is a per-IP block, not a missing credential.
import { connectionManager } from '../../../connections/manager.js';
import { HttpConnectionError } from '../../../connections/errors.js';
import { parseArxivAtomXml } from '../transform/arxiv.js';
import type { Article, ParsedDateRange } from '../types.js';

// Open date-range bounds (plan D5): arXiv's earliest submissions date to
// 1991-07; the upper bound only needs to exceed any real query date.
const DEFAULT_DATE_FROM = '199107010000';
const DEFAULT_DATE_TO = '209912312359';

// arXiv field prefixes (ti/au/abs/co/jr/cat/rn/all) are query syntax —
// neutralize them so user queries are treated as plain terms (plan D4).
const FIELD_PREFIX_PATTERN = /\b(?:ti|au|abs|co|jr|cat|rn|all):/gi;

function sanitizeArxivQuery(query: string): string {
  return query
    // Strip phrase/grouping syntax characters and field prefixes so the
    // raw query cannot accidentally narrow the search, then collapse the
    // resulting whitespace runs.
    .replace(/["()]/g, ' ')
    .replace(FIELD_PREFIX_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatArxivDateBound(date: string | undefined, timeSuffix: '0000' | '2359', fallback: string): string {
  if (!date) return fallback;
  return date.replace(/-/g, '') + timeSuffix;
}

export async function searchArxiv(
  query: string,
  limit: number,
  offset: number,
  dateRange?: ParsedDateRange
): Promise<Article[]> {
  try {
    // `+` is arXiv's documented space separator (≡ %20); the date filter is
    // the evidenced quoted submittedDate range (plan D5), with quotes
    // %22-encoded to mirror arXiv's own self-referencing feed links.
    let searchQuery = `all:(${encodeURIComponent(sanitizeArxivQuery(query))})`;
    if (dateRange?.from || dateRange?.to) {
      const from = formatArxivDateBound(dateRange.from, '0000', DEFAULT_DATE_FROM);
      const to = formatArxivDateBound(dateRange.to, '2359', DEFAULT_DATE_TO);
      searchQuery += `+AND+submittedDate:%22${from}+TO+${to}%22`;
    }

    // sortBy=relevance only; sortOrder is documented but unevidenced, so it
    // is omitted. max_results >30000 makes arXiv HTTP-500; interactive
    // pages are capped at 50 (plan D6).
    const path = `/query?search_query=${searchQuery}&start=${offset}&max_results=${Math.min(limit, 50)}&sortBy=relevance`;

    // arXiv always answers application/atom+xml, so the connection returns
    // response text. Retry/rate-limit policy lives on the registry entry.
    const conn = connectionManager.getConnection('arxiv');
    const xml = await conn.request(path) as string;

    return parseArxivAtomXml(xml);
  } catch (error) {
    if (error instanceof HttpConnectionError && error.status === 403) {
      // Reworded (plan D9): arXiv has no API keys, so the stock 403 hint
      // ("set the required API key") is a false lead — a 403 from arXiv is
      // a per-IP block, and retrying would only hammer a blocked IP.
      return [{
        _error:
          'searchArxiv failed: HTTP 403 from arXiv. This is most likely a per-IP block imposed after ' +
          'rate-limit violations of the arXiv API Terms of Use (https://info.arxiv.org/help/api/tou.html — ' +
          'max 1 request per 3 seconds). Wait before retrying, or contact arXiv administrators to request ' +
          'an unblock. Note: arXiv does not offer API keys, so there is no credential to configure.',
      } as any];
    }
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchArxiv] Error:', error);
    return [{ _error: `searchArxiv failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

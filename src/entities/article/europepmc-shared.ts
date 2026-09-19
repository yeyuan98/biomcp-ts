import { connectionManager } from '../../connections/manager.js';
import type { CitationRecord } from './citation/types.js';

/** Shared field assumptions for Europe PMC REST (v6.9) response records,
 * used by the search, citation, and citation-count adapters. */

/** resulttype=lite search row */
export interface EuropePMCRecord {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  journalVolume?: string | null;
  issue?: string | null;
  pageInfo?: string | null;
  firstPublicationDate?: string;
  citedByCount?: number;
  isOpenAccess?: string;
}

/** resultType=core search row for a preprint (source=PPR) record.
 * `abstractText` and `bookOrReportDetails` only exist in core results
 * (live-verified): abstracts and the per-record bioRxiv/medRxiv server
 * label are the point of the preprint search backend. */
export interface EuropePMCPreprintRecord {
  id?: string;
  source?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  abstractText?: string;
  firstPublicationDate?: string;
  citedByCount?: number;
  isOpenAccess?: string;
  /** "bioRxiv" or "medRxiv" for PPR records */
  bookOrReportDetails?: {
    publisher?: string;
    yearOfPublication?: number;
  };
  /** "Preprint of" entries link a preprint to its published version (PMID) */
  commentCorrectionList?: {
    commentCorrection?: Array<{
      source?: string;
      id?: string;
      type?: string;
      reference?: string;
    }>;
  };
}

/** row from /{source}/{id}/citations and /references lists */
export interface EuropePMCCitationEntry {
  id?: string;
  source?: string;
  title?: string;
  authorString?: string;
  journalAbbreviation?: string;
  journalTitle?: string;
  volume?: string;
  issue?: string;
  pageInfo?: string;
  pubYear?: string | number;
}

/** envelope of the /search endpoint responses (shared by the search,
 * preprint-search, preprint-detail, and citation adapters). */
export interface EuropePMCSearchResponse<Row = unknown> {
  hitCount?: number;
  resultList?: {
    result?: Row[];
  };
}

const XML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

export function cleanArticleTitle(title?: string): string | undefined {
  if (!title) return undefined;
  let s = title;
  let prev = '';

  // 1. Normalize sub/inf/sup: both escaped (&lt;sub&gt;...&lt;/sub&gt;) and raw (<sub>...</sub>)
  while (s !== prev) {
    prev = s;
    s = s.replace(/&lt;(?:sub|inf)\b.*?&gt;([\s\S]*?)&lt;\/(?:sub|inf)&gt;/gi, '($1)')
         .replace(/<(?:sub|inf)\b[^>]*>([\s\S]*?)<\/(?:sub|inf)>/gi, '($1)')
         .replace(/&lt;sup\b.*?&gt;([\s\S]*?)&lt;\/sup&gt;/gi, '($1)')
         .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, '($1)');
  }

  // 2. Strip all remaining HTML/XML tags (raw and escaped) until convergence
  prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(/&lt;\/?([a-zA-Z][a-zA-Z0-9:-]*)\b[^&>]*&gt;/gi, '')
         .replace(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*>/gi, '');
  }

  // 3. Decode standard XML entities and numeric character references in a single pass
  s = s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gi, (match) => {
    const lower = match.toLowerCase();
    if (XML_ENTITY_MAP[lower]) return XML_ENTITY_MAP[lower];
    if (lower.startsWith('&#x')) {
      const code = parseInt(match.slice(3, -1), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (lower.startsWith('&#')) {
      const code = parseInt(match.slice(2, -1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return match;
  });

  return s.trim() || undefined;
}

export function splitAuthors(authorString?: string): string[] | undefined {
  return authorString ? authorString.split(', ') : undefined;
}

export function parseYear(year?: string | number): number | undefined {
  if (year === undefined) return undefined;
  const parsed = parseInt(String(year), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function transformCitationEntry(entry: EuropePMCCitationEntry): CitationRecord {
  return {
    pmid: entry.source === 'MED' && entry.id !== undefined ? String(entry.id) : undefined,
    title: cleanArticleTitle(entry.title),
    authors: splitAuthors(entry.authorString),
    journal: entry.journalAbbreviation ?? entry.journalTitle,
    volume: entry.volume,
    issue: entry.issue,
    pages: entry.pageInfo,
    year: parseYear(entry.pubYear),
    source: 'europepmc',
  };
}

/** Year-granularity date filter for /search queries. Returns the bare
 * `pub_year:[X TO Y]` predicate ('' when the range is absent), with `*`
 * as the open-bound sentinel on either side. Callers append it with a
 * leading ' AND ' only when non-empty. */
export function epmcPubYearClause(dateRange?: { from?: string; to?: string }): string {
  if (!dateRange?.from && !dateRange?.to) return '';
  const fromYear = dateRange.from ? dateRange.from.slice(0, 4) : '*';
  const toYear = dateRange.to ? dateRange.to.slice(0, 4) : '*';
  return `pub_year:[${fromYear} TO ${toYear}]`;
}

/** Server label for a Europe PMC preprint (source=PPR) record: the
 * publisher field is "medRxiv" or "bioRxiv"; anything else (including
 * missing) defaults to bioRxiv. */
export function epmcPreprintServerLabel(publisher?: string): 'bioRxiv' | 'medRxiv' {
  return publisher === 'medRxiv' ? 'medRxiv' : 'bioRxiv';
}

/** Core /search mechanics shared by the journal (search/europepmc.ts)
 * and preprint (search/preprint.ts) backends: query assembly, optional
 * year-granularity date clause, and window selection. Returns the rows
 * of the requested window; errors propagate to the caller so each
 * backend keeps its own `_error` row envelope.
 *
 * EuropePMC has no server-side offset: the `page` parameter is silently
 * ignored (live-verified: page=1/3/10 return identical rows) and
 * cursorMark deep-paging cannot jump to a row, so over-fetch the window
 * in one request (pageSize hard-caps at 1000 — larger requests are
 * answered with an errCode:404 body) and window client-side, mirroring
 * the LitSense/PubTator pagination pattern. An explicit cursorMark takes
 * precedence and defines the window start (the cursor already skips
 * preceding rows), so offset is ignored in that case.
 *
 * `resultTypeParam` is interpolated verbatim: the journal backend sends
 * `resulttype=lite` while the preprint backend sends `resultType=core`
 * (both live-verified shapes). */
export async function epmcSearchWindow<Row = unknown>(options: {
  query: string;
  resultTypeParam: string;
  limit: number;
  offset: number;
  cursorMark?: string;
  dateRange?: { from?: string; to?: string };
}): Promise<Row[]> {
  const conn = connectionManager.getConnection('europepmc');

  let queryString = options.query;
  const dateClause = epmcPubYearClause(options.dateRange);
  if (dateClause) queryString += ` AND ${dateClause}`;

  const fromCursor = Boolean(options.cursorMark);
  const fetchLimit = fromCursor ? options.limit : Math.min(options.limit + options.offset, 1000);
  const cursor = options.cursorMark || '*';
  const response = await conn.request(
    `/search?query=${encodeURIComponent(queryString)}&${options.resultTypeParam}&format=json&pageSize=${fetchLimit}&cursorMark=${encodeURIComponent(cursor)}`
  ) as EuropePMCSearchResponse<Row>;

  const rows = response.resultList?.result || [];
  return fromCursor ? rows.slice(0, options.limit) : rows.slice(options.offset, options.offset + options.limit);
}

import { connectionManager } from '../../../connections/manager.js';
import type { Article, ParsedDateRange } from '../types.js';
import { EuropePMCPreprintRecord, splitAuthors, cleanArticleTitle } from '../europepmc-shared.js';

interface EuropePMCSearchResponse {
  resultList?: {
    result?: EuropePMCPreprintRecord[];
  };
}

export function transformPreprint(a: EuropePMCPreprintRecord): Article {
  const server = a.bookOrReportDetails?.publisher === 'medRxiv' ? 'medRxiv' : 'bioRxiv';
  return {
    doi: a.doi,
    title: cleanArticleTitle(a.title),
    abstract: a.abstractText,
    authors: splitAuthors(a.authorString),
    journal: server,
    publication_date: a.firstPublicationDate,
    cited_by: a.citedByCount,
    is_open_access: a.isOpenAccess === 'Y',
    publication_types: ['Preprint'],
    source: 'preprint_only',
    preprint_server: server,
    ppr_id: a.id,
  };
}

/**
 * Preprint-only search across bioRxiv + medRxiv, served by Europe PMC's
 * preprint index (source=PPR). `PUBLISHER:(bioRxiv OR medRxiv)` is the
 * reliable server filter (DB:biorxiv and DOI wildcards return 0 —
 * live-verified); `resultType=core` is required because `abstractText`
 * and `bookOrReportDetails.publisher` only exist in core results.
 * The official api.biorxiv.org has no keyword-search endpoint at all, so
 * Europe PMC is the only route for topical preprint discovery; the official
 * API is used for record fetching (detail/preprint.ts).
 */
export async function searchPreprints(
  query: string,
  limit: number,
  offset: number,
  cursorMark?: string,
  dateRange?: ParsedDateRange
): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('europepmc');

    let queryString = `(${query}) AND SRC:PPR AND PUBLISHER:(bioRxiv OR medRxiv)`;
    if (dateRange?.from || dateRange?.to) {
      const fromYear = dateRange.from ? dateRange.from.slice(0, 4) : '*';
      const toYear = dateRange.to ? dateRange.to.slice(0, 4) : '*';
      queryString += ` AND pub_year:[${fromYear} TO ${toYear}]`;
    }

    // Same over-fetch windowing as the journal backend (europepmc.ts):
    // the `page` param is silently ignored and cursorMark cannot jump to a
    // row, so window client-side; pageSize hard-caps at 1000. An explicit
    // cursorMark defines the window start (offset ignored in that case).
    const fromCursor = Boolean(cursorMark);
    const fetchLimit = fromCursor ? limit : Math.min(limit + offset, 1000);
    const cursor = cursorMark || '*';
    const response = await conn.request(
      `/search?query=${encodeURIComponent(queryString)}&resultType=core&format=json&pageSize=${fetchLimit}&cursorMark=${encodeURIComponent(cursor)}`
    ) as EuropePMCSearchResponse;

    const rows = response.resultList?.result || [];
    const window = fromCursor ? rows.slice(0, limit) : rows.slice(offset, offset + limit);
    return window.map(transformPreprint);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchPreprints] Error:', error);
    return [{ _error: `searchPreprints failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

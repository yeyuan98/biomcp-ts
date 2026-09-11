import { connectionManager } from '../../../connections/manager.js';
import type { Article, ParsedDateRange } from '../types.js';
import { EuropePMCRecord, splitAuthors, cleanArticleTitle } from '../europepmc-shared.js';

interface EuropePMCResponse {
  resultList?: {
    result?: EuropePMCRecord[];
  };
}

export function transformEuropePMC(a: EuropePMCRecord): Article {
  return {
    pmid: a.pmid,
    pmcid: a.pmcid,
    doi: a.doi,
    title: cleanArticleTitle(a.title),
    authors: splitAuthors(a.authorString),
    journal: a.journalTitle,
    volume: a.journalVolume ?? undefined,
    issue: a.issue ?? undefined,
    pages: a.pageInfo ?? undefined,
    publication_date: a.firstPublicationDate,
    cited_by: a.citedByCount,
    is_open_access: a.isOpenAccess === 'Y',
    source: 'europepmc',
  };
}

export async function searchEuropePMC(query: string, limit: number, offset: number, cursorMark?: string, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('europepmc');

    let queryString = query;
    if (dateRange?.from || dateRange?.to) {
      const fromYear = dateRange.from ? dateRange.from.slice(0, 4) : '*';
      const toYear = dateRange.to ? dateRange.to.slice(0, 4) : '*';
      queryString += ` AND pub_year:[${fromYear} TO ${toYear}]`;
    }

    // EuropePMC has no server-side offset: the `page` parameter is silently
    // ignored (live-verified: page=1/3/10 return identical rows) and
    // cursorMark deep-paging cannot jump to a row, so over-fetch the window
    // in one request (pageSize hard-caps at 1000 — larger requests are
    // answered with an errCode:404 body) and window client-side, mirroring
    // the LitSense/PubTator pagination pattern. An explicit cursorMark takes
    // precedence and defines the window start (the cursor already skips
    // preceding rows), so offset is ignored in that case.
    const fromCursor = Boolean(cursorMark);
    const fetchLimit = fromCursor ? limit : Math.min(limit + offset, 1000);
    const cursor = cursorMark || '*';
    const response = await conn.request(
      `/search?query=${encodeURIComponent(queryString)}&resulttype=lite&format=json&pageSize=${fetchLimit}&cursorMark=${encodeURIComponent(cursor)}`
    ) as EuropePMCResponse;

    const rows = response.resultList?.result || [];
    const window = fromCursor ? rows.slice(0, limit) : rows.slice(offset, offset + limit);
    return window.map(transformEuropePMC);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchEuropePMC] Error:', error);
    return [{ _error: `searchEuropePMC failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

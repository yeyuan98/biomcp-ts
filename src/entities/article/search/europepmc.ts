import { connectionManager } from '../../../connections/manager.js';
import type { Article, ParsedDateRange } from '../types.js';
import { EuropePMCRecord, splitAuthors } from '../europepmc-shared.js';

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
    title: a.title,
    authors: splitAuthors(a.authorString),
    journal: a.journalTitle,
    publication_date: a.firstPublicationDate,
    cited_by: a.citedByCount,
    is_open_access: a.isOpenAccess === 'Y',
    source: 'europepmc',
  };
}

export async function searchEuropePMC(query: string, limit: number, _offset: number, cursorMark?: string, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('europepmc');

    let queryString = query;
    if (dateRange?.from || dateRange?.to) {
      const fromYear = dateRange.from ? dateRange.from.slice(0, 4) : '*';
      const toYear = dateRange.to ? dateRange.to.slice(0, 4) : '*';
      queryString += ` AND pub_year:[${fromYear} TO ${toYear}]`;
    }

    const cursor = cursorMark || '*';
    const response = await conn.request(
      `/search?query=${encodeURIComponent(queryString)}&resulttype=lite&format=json&pageSize=${limit}&cursorMark=${encodeURIComponent(cursor)}`
    ) as EuropePMCResponse;

    return (response.resultList?.result || []).map(transformEuropePMC);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchEuropePMC] Error:', error);
    return [{ _error: `searchEuropePMC failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

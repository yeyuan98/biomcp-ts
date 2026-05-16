import { connectionManager } from '../../../connections/manager.js';
import type { Article, ParsedDateRange } from '../types.js';

export interface EuropePMCResult {
  pubmedId?: string;
  pmcId?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  firstPublicationDate?: string;
  citedByCount?: number;
  isOpenAccess?: string;
}

interface EuropePMCResponse {
  resultList?: {
    result?: Array<{
      pubmedId?: string;
      pmcId?: string;
      doi?: string;
      title?: string;
      authorString?: string;
      journalTitle?: string;
      firstPublicationDate?: string;
      citedByCount?: number;
      isOpenAccess?: string;
    }>;
  };
}

export function transformEuropePMC(a: EuropePMCResult): Article {
  return {
    pmid: a.pubmedId,
    pmcid: a.pmcId,
    doi: a.doi,
    title: a.title,
    authors: a.authorString?.split(', '),
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

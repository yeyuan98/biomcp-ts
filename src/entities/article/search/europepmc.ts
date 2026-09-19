import type { Article, ParsedDateRange } from '../types.js';
import { EuropePMCRecord, splitAuthors, cleanArticleTitle, epmcSearchWindow } from '../europepmc-shared.js';

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
    const rows = await epmcSearchWindow<EuropePMCRecord>({
      query,
      resultTypeParam: 'resulttype=lite',
      limit,
      offset,
      cursorMark,
      dateRange,
    });
    return rows.map(transformEuropePMC);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchEuropePMC] Error:', error);
    return [{ _error: `searchEuropePMC failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

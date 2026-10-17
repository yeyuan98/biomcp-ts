import type { Article, ParsedDateRange } from '../types.js';
import { EuropePMCRecord, splitAuthors, cleanArticleTitle, epmcSearchWindow } from '../europepmc-shared.js';
import { backendErrorRow } from './backend-error.js';
import { rewriteJournalPhrase } from './journal-titles.js';

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

export async function searchEuropePMC(query: string, limit: number, offset: number, cursorMark?: string, dateRange?: ParsedDateRange, warnings?: string[], signal?: AbortSignal): Promise<Article[]> {
  try {
    // Journal-name rewrite (issue #121): Europe PMC's JOURNAL:"..." filter
    // needs the NLM abbreviation, so a trailing full journal name would
    // otherwise match nothing (or the wrong free-text terms). When the
    // query ENDS with a known full journal name (bundled NLM title list),
    // hoist it into an explicit JOURNAL clause and disclose the rewrite.
    // The preprint path (search/preprint.ts) deliberately does NOT do
    // this — preprint queries scope by server, not journal.
    let searchQuery = query;
    const journalRewrite = rewriteJournalPhrase(query);
    if (journalRewrite) {
      searchQuery = journalRewrite.rewrittenQuery
        ? `(${journalRewrite.rewrittenQuery}) AND JOURNAL:"${journalRewrite.medAbbr}"`
        : `JOURNAL:"${journalRewrite.medAbbr}"`;
      warnings?.push(
        `Journal phrase rewritten: '${journalRewrite.originalPhrase}' → 'JOURNAL:"${journalRewrite.medAbbr}"'.`
      );
    }
    const rows = await epmcSearchWindow<EuropePMCRecord>({
      query: searchQuery,
      resultTypeParam: 'resulttype=lite',
      limit,
      offset,
      cursorMark,
      dateRange,
      signal,
    });
    return rows.map(transformEuropePMC);
  } catch (error) {
    return backendErrorRow('searchEuropePMC', error);
  }
}

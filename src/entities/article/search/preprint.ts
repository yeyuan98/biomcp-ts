import type { Article, ParsedDateRange } from '../types.js';
import { EuropePMCPreprintRecord, splitAuthors, cleanArticleTitle, epmcSearchWindow, epmcPreprintServerLabel } from '../europepmc-shared.js';
import { backendErrorRow } from './backend-error.js';

export function transformPreprint(a: EuropePMCPreprintRecord): Article {
  const server = epmcPreprintServerLabel(a.bookOrReportDetails?.publisher);
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
    const rows = await epmcSearchWindow<EuropePMCPreprintRecord>({
      query: `(${query}) AND SRC:PPR AND PUBLISHER:(bioRxiv OR medRxiv)`,
      resultTypeParam: 'resultType=core',
      limit,
      offset,
      cursorMark,
      dateRange,
    });
    return rows.map(transformPreprint);
  } catch (error) {
    return backendErrorRow('searchPreprints', error);
  }
}

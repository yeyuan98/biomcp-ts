/** Journal-metrics entity types (journal_metrics tool, backed by OpenAlex
 * /sources). Kept as a dedicated module so the tool layer and tests can
 * import the shapes without pulling in the OpenAlex implementation. */

/** One year-row of a journal's activity (works published vs citations
 * received); OpenAlex serves up to ~10 recent years, unsorted. */
export interface JournalMetricsCount {
  year: number;
  works_count: number;
  cited_by_count: number;
}

/** One OpenAlex /sources record, transformed for the tool reply.
 * `summary_stats` is null when OpenAlex has none (a young or zombie
 * record); optional fields are simply absent when upstream omits them. */
export interface JournalMetrics {
  openalex_id: string;
  source: 'openalex';
  display_name: string;
  alternate_titles?: string[];
  issn_l?: string;
  issn?: string[];
  type?: string;
  is_oa?: boolean;
  is_in_doaj?: boolean;
  is_core?: boolean;
  homepage_url?: string;
  works_count?: number;
  cited_by_count?: number;
  summary_stats?: {
    two_year_mean_citedness: number;
    h_index: number;
    i10_index: number;
  } | null;
  counts_by_year?: JournalMetricsCount[];
  listed_in?: string[];
}

/** One upstream failure inside the journal_metrics envelope (article_search
 * per-source error parity). */
export interface JournalMetricsError {
  source: string;
  message: string;
  retryable?: boolean;
}

/** Standard reply envelope: results plus disclosure channels. `warnings`
 * carry preprocessing/normalization disclosures (abbreviation expansion,
 * duplicate-record suppression, zero-hit hints); `errors` carries upstream
 * failures instead of failing the whole call. */
export interface JournalMetricsResult {
  results: JournalMetrics[];
  warnings: string[];
  errors: JournalMetricsError[];
}

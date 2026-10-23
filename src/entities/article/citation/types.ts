/**
 * Article identifier supporting multiple ID types
 */
export interface ArticleId {
  /** PubMed ID */
  pmid?: string;
  /** PubMed Central ID */
  pmcid?: string;
  /** Digital Object Identifier */
  doi?: string;
}

/**
 * A citation record with metadata from a provider
 */
export interface CitationRecord {
  /** PubMed ID */
  pmid?: string;
  /** PubMed Central ID */
  pmcid?: string;
  /** Digital Object Identifier */
  doi?: string;
  /** Article title */
  title?: string;
  /** Author list */
  authors?: string[];
  /** Journal name */
  journal?: string;
  /** Journal ISSN (e.g. '0028-0836') */
  journal_issn?: string;
  /** Journal volume */
  volume?: string;
  /** Journal issue */
  issue?: string;
  /** Pages or article number (e.g. '2507-16', 'e71310') */
  pages?: string;
  /** Publication year */
  year?: number;
  /** Provider source (e.g., 'europepmc', 'semantic_scholar') */
  source: string;
}

/**
 * Citation count summary from a provider
 */
export interface CitationCount {
  /** Total citation count */
  total: number;
  /** Citations by year */
  by_year?: Record<number, number>;
  /** Provider source */
  source: string;
}

/**
 * Citation query result from a single provider
 */
export interface SourceCitationResult {
  /** Provider identifier */
  source_id: string;
  /** Citation count if available */
  citation_count?: CitationCount;
  /** Forward citations (articles citing this one) */
  forward_citations: CitationRecord[];
  /** Backward references (articles cited by this one) */
  backward_references: CitationRecord[];
  /** Error message if query failed */
  error?: string;
}

/**
 * Compact per-provider summary of what a citation source contributed.
 *
 * The records themselves live only once — in the deduplicated
 * `forward_citations`/`backward_references` arrays of the federated result.
 * Summaries carry counts and errors, never record arrays, so a citation
 * reply does not ship every record twice (issue #60: the duplicated
 * `source_results` arrays leaked large citation sections into context).
 */
export interface CitationSourceSummary {
  /** Provider identifier (e.g. 'europepmc') */
  source_id: string;
  /** Human-readable provider name (e.g. 'Europe PMC') */
  source: string;
  /** Forward citation records the provider returned (pre-deduplication) */
  forward_count: number;
  /** Backward reference records the provider returned (pre-deduplication) */
  backward_count: number;
  /** Total records the provider returned (forward + backward, pre-dedup) */
  total: number;
  /** Error message if the provider query failed (verbatim) */
  error?: string;
}

/**
 * Federated citation result aggregating data from multiple providers
 */
export interface FederatedCitationResult {
  /** Article identifier used for the query */
  article_id: ArticleId;
  /** Citation counts from all providers */
  citation_counts: CitationCount[];
  /** Deduplicated forward citations */
  forward_citations: CitationRecord[];
  /** Deduplicated backward references */
  backward_references: CitationRecord[];
  /** Per-provider summaries (counts + verbatim errors); built by
   *  `summarizeSourceResults()` on both the federation path and the preprint
   *  PPR path — the records themselves live only in the deduplicated
   *  forward/backward arrays above, never duplicated per provider. */
  source_results: CitationSourceSummary[];
  /** Whether any citation items were returned */
  items_available: boolean;
}

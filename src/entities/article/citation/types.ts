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
  /** Individual provider results */
  source_results: SourceCitationResult[];
  /** Whether any citation items were returned */
  items_available: boolean;
}

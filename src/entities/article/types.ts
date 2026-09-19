export interface ArticleSearchOptions {
  source?: 'pubmed' | 'europepmc' | 'semantic_scholar' | 'pubtator' | 'litsense' | 'preprint_only' | 'arxiv';
  limit?: number;
  offset?: number;
  cursorMark?: string;
  dateRange?: string;
}

export interface ParsedDateRange {
  from?: string;
  to?: string;
}

export interface PreprintFunder {
  name?: string;
  id?: string;
  id_type?: string;
  award?: string;
}

export interface PreprintVersionInfo {
  version: number;
  date?: string;
  type?: string;
  doi?: string;
}

export interface PreprintCorrespondingAuthor {
  name?: string;
  institution?: string;
}

export interface PreprintDetails {
  data_source: 'api.biorxiv.org' | 'europepmc';
  versions: PreprintVersionInfo[];
  corresponding_author?: PreprintCorrespondingAuthor;
  funders?: PreprintFunder[];
}

export interface PreprintPublishedVersion {
  doi?: string;
  journal?: string;
  published_date?: string;
  preprint_date?: string;
  pmid?: string;
  source: 'biorxiv_pubs' | 'biorxiv_details' | 'europepmc';
}

export interface Article {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  arxiv_id?: string;
  title?: string;
  abstract?: string;
  authors?: string[];
  journal?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publication_date?: string;
  cited_by?: number;
  is_open_access?: boolean;
  source?: string;
  score?: number;
  mesh_headings?: string[];
  publication_types?: string[];
  keywords?: string[];
  chemicals?: string[];
  /** Preprint records only: 'bioRxiv' | 'medRxiv' */
  preprint_server?: string;
  /** Europe PMC preprint accession (e.g. PPR1234567) */
  ppr_id?: string;
  /** Preprint license code from api.biorxiv.org ('cc_by', 'cc_by_nc_nd', ...; 'na' = copyright retained) */
  license?: string;
  /** bioRxiv/medRxiv subject category */
  category?: string;
  /** Latest preprint version number */
  version?: number;
  /** URL of the full-text JATS XML on www.biorxiv.org (not fetched; served as a link) */
  jatsxml_url?: string;
  _error?: string;
}

export interface ArticleGetOptions {
  sections?: string[];
  limit?: number;
}

export interface ArticleResult extends Article {
  sections?: Record<string, unknown>;
  preprint?: PreprintDetails;
  published?: PreprintPublishedVersion | null;
}

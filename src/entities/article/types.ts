export interface ArticleSearchOptions {
  source?: 'pubmed' | 'europepmc' | 'semantic_scholar' | 'pubtator' | 'litsense';
  limit?: number;
  offset?: number;
  cursorMark?: string;
  dateRange?: string;
}

export interface ParsedDateRange {
  from?: string;
  to?: string;
}

export interface Article {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  abstract?: string;
  authors?: string[];
  journal?: string;
  publication_date?: string;
  cited_by?: number;
  is_open_access?: boolean;
  source?: string;
  score?: number;
  mesh_headings?: string[];
  publication_types?: string[];
  keywords?: string[];
  chemicals?: string[];
  _error?: string;
}

export interface ArticleGetOptions {
  sections?: string[];
  limit?: number;
}

export interface ArticleResult extends Article {
  sections?: Record<string, unknown>;
}

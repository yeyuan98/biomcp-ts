export type PatentSource = 'ops' | 'uspto_odp' | 'ppubs' | 'google_patents';

export type PatentStatus = 'granted' | 'application';

export type PatentSortBy = 'relevance' | 'recency';

export interface PatentSearchOptions {
  source?: PatentSource;
  assignee?: string;
  inventor?: string;
  cpc?: string;
  status?: PatentStatus;
  date_range?: string;
  limit?: number;
  offset?: number;
  sort_by?: PatentSortBy;
}

export interface PatentSearchResult {
  publication_number: string;
  title?: string;
  snippet?: string;
  publication_date?: string;
  filing_date?: string;
  priority_date?: string;
  assignee?: string[];
  inventor?: string[];
  applicant?: string[];
  cpc_codes?: string[];
  status?: PatentStatus;
  language?: string;
  relevance_score?: number;
  source: PatentSource;
  also_found_in?: PatentSource[];
  _error?: string;
  _note?: string;
  _hint?: string;
}

export interface PatentSearchResponse {
  patents: PatentSearchResult[];
  total_hits?: Partial<Record<PatentSource, number>>;
  /** Documents what each backend's total_hits number counts (per-backend semantics differ). */
  total_hits_basis?: Partial<Record<PatentSource, string>>;
}

export interface PatentCitationEntry {
  publication_number?: string;
  title?: string;
  publication_date?: string;
  assignee?: string;
}

export interface PatentClaimsSection {
  claims: string[];
  number_of_claims?: number;
  source: PatentSource;
  _warn?: string;
}

export interface PatentCitationsSection {
  backward: PatentCitationEntry[];
  forward: PatentCitationEntry[];
  non_patent_literature?: string[];
  source: PatentSource;
}

export interface PatentFamilySection {
  family_members: string[];
  source: PatentSource;
}

export interface PatentClassificationsSection {
  cpc: string[];
  ipc: string[];
  source: PatentSource;
}

export interface PatentResult {
  publication_number: string;
  title?: string;
  abstract?: string;
  publication_date?: string;
  filing_date?: string;
  priority_date?: string;
  assignee?: string[];
  inventors?: string[];
  applicant?: string[];
  legal_status?: string;
  cpc?: string[];
  ipc?: string[];
  family_id?: string;
  family_members?: string[];
  sections?: Record<string, unknown>;
}

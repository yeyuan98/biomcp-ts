import { connectionManager } from '../../../connections/manager.js';
import { withTimeout } from '../../../connections/fetch-utils.js';
import type { Article, ParsedDateRange } from '../types.js';
import { s2RequestQueue } from '../semantic-scholar-queue.js';

export interface SemanticScholarPaper {
  title?: string;
  abstract?: string;
  authors?: Array<{ name: string }>;
  year?: number;
  venue?: string;
  citationCount?: number;
  isOpenAccess?: boolean;
  externalIds?: {
    PMID?: string;
    PMCID?: string;
    DOI?: string;
  };
}

interface SemanticScholarResponse {
  data?: Array<{
    paperId?: string;
    title?: string;
    abstract?: string;
    authors?: Array<{ name: string }>;
    year?: number;
    venue?: string;
    citationCount?: number;
    isOpenAccess?: boolean;
    externalIds?: {
      PMID?: string;
      PMCID?: string;
      DOI?: string;
    };
  }>;
}

export function transformSemanticScholar(a: SemanticScholarPaper): Article {
  return {
    pmid: a.externalIds?.PMID,
    pmcid: a.externalIds?.PMCID,
    doi: a.externalIds?.DOI,
    title: a.title,
    abstract: a.abstract,
    authors: a.authors?.map((au: { name: string }) => au.name),
    journal: a.venue,
    publication_date: a.year ? String(a.year) : undefined,
    cited_by: a.citationCount,
    is_open_access: a.isOpenAccess,
    source: 'semantic_scholar',
  };
}

// Retry policy lives on the registry 'semantic_scholar' source config; the
// shared S2 queue serializes this traffic with citation lookups.
export async function searchSemanticScholar(query: string, limit: number, offset: number, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('semantic_scholar');

    let searchUrl = `/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&fields=title,abstract,authors,year,venue,citationCount,isOpenAccess,externalIds`;
    if (dateRange?.from || dateRange?.to) {
      const from = dateRange.from || '';
      const to = dateRange.to || '';
      searchUrl += `&publicationDateOrYear=${from}:${to}`;
    }

    // withTimeout INSIDE the queue slot: a hung fetch must release the queue
    // for the next S2 caller instead of poisoning it.
    const response = await s2RequestQueue.enqueue(
      () => withTimeout(
        conn.request(searchUrl) as Promise<SemanticScholarResponse>,
        15000,
        { onTimeout: 'throw', label: 'SemanticScholar search' }
      )
    );

    return (response.data || []).map(transformSemanticScholar);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchSemanticScholar] Error:', error);
    return [{ _error: `searchSemanticScholar failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

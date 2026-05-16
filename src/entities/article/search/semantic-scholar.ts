import { connectionManager } from '../../../connections/manager.js';
import type { Article, ParsedDateRange } from '../types.js';
import { withRetry } from '../../../connections/retry.js';

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

// Retry configuration for Semantic Scholar
// Use shorter delays with API key, longer without
function getRetryConfig() {
  return {
    maxRetries: 1,
    baseDelayMs: process.env.S2_API_KEY ? 200 : 500,
    logger: { warn: (msg: string) => console.warn(`[semantic_scholar] ${msg}`) }
  };
}

export async function searchSemanticScholar(query: string, limit: number, offset: number, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    const response = await withRetry(async () => {
      const conn = connectionManager.getConnection('semantic_scholar');

      let searchUrl = `/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&fields=title,abstract,authors,year,venue,citationCount,isOpenAccess,externalIds`;
      if (dateRange?.from || dateRange?.to) {
        const from = dateRange.from || '';
        const to = dateRange.to || '';
        searchUrl += `&publicationDateOrYear=${from}:${to}`;
      }

      return await conn.request(searchUrl) as SemanticScholarResponse;
    }, getRetryConfig());

    return (response.data || []).map(transformSemanticScholar);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchSemanticScholar] Error:', error);
    return [{ _error: `searchSemanticScholar failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

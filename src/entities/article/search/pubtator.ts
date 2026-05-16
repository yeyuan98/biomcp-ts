import { connectionManager } from '../../../connections/manager.js';
import type { Article } from '../types.js';

export interface PubTatorResult {
  _id: string;
  pmid: number;
  pmcid?: string;
  title: string;
  journal?: string;
  authors?: string[];
  date?: string;
  doi?: string;
  score?: number;
}

interface PubTatorResponse {
  results?: Array<{
    _id: string;
    pmid: number;
    pmcid?: string;
    title: string;
    journal?: string;
    authors?: string[];
    date?: string;
    doi?: string;
    score?: number;
  }>;
}

export function transformPubTator(a: PubTatorResult): Article {
  return {
    pmid: String(a.pmid),
    pmcid: a.pmcid,
    title: a.title,
    authors: a.authors,
    journal: a.journal,
    doi: a.doi,
    publication_date: a.date,
    score: a.score,
    source: 'pubtator',
  };
}

export async function searchPubTator(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('pubtator');

    const response = await conn.request(
      `/search/?text=${encodeURIComponent(query)}`
    ) as PubTatorResponse;

    return (response.results || []).slice(offset, offset + limit).map(transformPubTator);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchPubTator] Error:', error);
    return [{ _error: `searchPubTator failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

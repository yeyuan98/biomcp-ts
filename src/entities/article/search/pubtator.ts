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
    if (limit <= 0) return [];
    const conn = connectionManager.getConnection('pubtator');

    // Server-side pagination: PubTator honors `page`/`size` (size clamped to
    // a minimum of 10 by the API) and otherwise returns only page 1 (10
    // records), which made any offset>=10 window come back empty. Size the
    // page to cover the requested window (bounded at the API max of 100).
    const size = Math.min(Math.max(limit + offset, 10), 100);
    const page = Math.floor(offset / size) + 1;
    const start = offset - (page - 1) * size;

    const response = await conn.request(
      `/search/?text=${encodeURIComponent(query)}&page=${page}&size=${size}`
    ) as PubTatorResponse;

    return (response.results || []).slice(start, start + limit).map(transformPubTator);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchPubTator] Error:', error);
    return [{ _error: `searchPubTator failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

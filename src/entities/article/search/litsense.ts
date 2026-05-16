import { connectionManager } from '../../../connections/manager.js';
import type { Article } from '../types.js';

export interface LitSenseResult {
  pmid: number;
  pmcid?: string;
  text: string;
  score: number;
  section: string;
  annotations: string[];
}

interface LitSenseResponse {
  pmid: number;
  pmcid?: string;
  text: string;
  score: number;
  section: string;
  annotations: string[];
}

export function transformLitSense(a: LitSenseResult): Article {
  return {
    pmid: String(a.pmid),
    pmcid: a.pmcid,
    abstract: a.text,
    score: a.score,
    source: 'litsense',
  };
}

export async function searchLitSense(query: string, limit: number, _offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('litsense');

    const response = await conn.request(
      `/sentences/?query=${encodeURIComponent(query)}&size=${limit}`
    ) as LitSenseResponse;

    return (Array.isArray(response) ? response : []).slice(0, limit).map(transformLitSense);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchLitSense] Error:', error);
    return [{ _error: `searchLitSense failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

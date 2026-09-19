import { connectionManager } from '../../../connections/manager.js';
import type { Article } from '../types.js';
import { backendErrorRow } from './backend-error.js';

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
    score: a.score,
    source: 'litsense',
  };
}

export async function searchLitSense(query: string, limit: number, offset: number): Promise<Article[]> {
  try {
    const conn = connectionManager.getConnection('litsense');

    // The LitSense API ignores server-side offsets (live-verified; responses
    // are silently capped at 300 rows), so over-fetch and window client-side,
    // mirroring the PubTator pagination pattern.
    const fetchLimit = Math.min(limit + offset, 300);
    const response = await conn.request(
      `/sentences/?query=${encodeURIComponent(query)}&limit=${fetchLimit}`
    ) as LitSenseResponse;

    return (Array.isArray(response) ? response : []).slice(offset, offset + limit).map(transformLitSense);
  } catch (error) {
    return backendErrorRow('searchLitSense', error);
  }
}

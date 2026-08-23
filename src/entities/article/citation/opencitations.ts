import { connectionManager } from '../../../connections/manager.js';
import type { ArticleId, CitationRecord, CitationCount } from './types.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../../connections/fetch-utils.js';

interface OpenCitationsCitation {
  citing?: string;
  cited?: string;
  creation?: string;
}

interface OpenCitationsReference {
  citing?: string;
  cited?: string;
  creation?: string;
}

export async function getForwardCitations(id: ArticleId, limit: number): Promise<CitationRecord[]> {
  if (!id.doi) return [];

  try {
    const conn = connectionManager.getConnection('opencitations');

    const response = await withTimeout(
      conn.request(`/v2/citations/${encodeURIComponent(id.doi)}`) as Promise<OpenCitationsCitation[]>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response || !Array.isArray(response)) return [];

    return response.slice(0, limit).map((item: OpenCitationsCitation) => ({
      doi: item.citing,
      source: 'opencitations',
    }));
  } catch (error) {
    console.error('[opencitations/getForwardCitations] Error:', error);
    return [];
  }
}

export async function getBackwardReferences(id: ArticleId, limit: number, articleYear?: number): Promise<CitationRecord[]> {
  if (!id.doi) return [];

  try {
    const conn = connectionManager.getConnection('opencitations');

    const response = await withTimeout(
      conn.request(`/references/${encodeURIComponent(id.doi)}`) as Promise<OpenCitationsReference[]>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response || !Array.isArray(response)) return [];

    // OpenCitations API doesn't return year information, so we cannot filter by articleYear.
    // The API only returns DOI strings without publication dates.
    return response.slice(0, limit).map((item: OpenCitationsReference) => ({
      doi: item.cited,
      source: 'opencitations',
    }));
  } catch (error) {
    console.error('[opencitations/getBackwardReferences] Error:', error);
    return [];
  }
}

export async function getCitationCount(id: ArticleId): Promise<CitationCount | null> {
  if (!id.doi) return null;

  try {
    const conn = connectionManager.getConnection('opencitations');

    const response = await withTimeout(
      conn.request(`/citation-count/${encodeURIComponent(id.doi)}`) as Promise<Array<{ count?: number }>>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response || !Array.isArray(response) || response.length === 0) return null;

    const count = response[0]?.count;
    if (count === undefined) return null;

    return { total: count, source: 'opencitations' };
  } catch (error) {
    console.error('[opencitations/getCitationCount] Error:', error);
    return null;
  }
}

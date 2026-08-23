import { connectionManager } from '../../../connections/manager.js';
import type { ArticleId, CitationRecord, CitationCount } from './types.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../../connections/fetch-utils.js';

interface OpenCitationsRow {
  citing?: string;
  cited?: string;
  creation?: string;
}

// v2 rows identify papers as space-separated PID strings, e.g.
// "omid:br/06202413427 doi:10.1021/ci2003126 openalex:W2079223054 pmid:22145975"
const DOI_PID = /\bdoi:(\S+)/;
const PMID_PID = /\bpmid:(\S+)/;

function transformRow(pids: string | undefined): CitationRecord {
  return {
    doi: pids?.match(DOI_PID)?.[1],
    pmid: pids?.match(PMID_PID)?.[1],
    source: 'opencitations',
  };
}

export async function getForwardCitations(id: ArticleId, limit: number): Promise<CitationRecord[]> {
  if (!id.doi) return [];

  try {
    const conn = connectionManager.getConnection('opencitations');

    const response = await withTimeout(
      conn.request(`/citations/doi:${encodeURIComponent(id.doi)}`) as Promise<OpenCitationsRow[]>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response || !Array.isArray(response)) return [];

    return response.slice(0, limit).map((item: OpenCitationsRow) => transformRow(item.citing));
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
      conn.request(`/references/doi:${encodeURIComponent(id.doi)}`) as Promise<OpenCitationsRow[]>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response || !Array.isArray(response)) return [];

    // `creation` dates the citation (the citing paper's publication), not the
    // cited reference, so backward references cannot be filtered by articleYear.
    return response.slice(0, limit).map((item: OpenCitationsRow) => transformRow(item.cited));
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
      conn.request(`/citation-count/doi:${encodeURIComponent(id.doi)}`) as Promise<Array<{ count?: string }>>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response || !Array.isArray(response) || response.length === 0) return null;

    const count = parseInt(response[0]?.count ?? '', 10);
    if (Number.isNaN(count)) return null;

    return { total: count, source: 'opencitations' };
  } catch (error) {
    console.error('[opencitations/getCitationCount] Error:', error);
    return null;
  }
}

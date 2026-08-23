import { connectionManager } from '../../../connections/manager.js';
import type { ArticleId, CitationRecord, CitationCount } from './types.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../../connections/fetch-utils.js';

interface EuropePMCCitationHit {
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalTitle?: string;
  pubYear?: string;
}

interface EuropePMCCitationsResponse {
  citationsArray?: {
    citation?: EuropePMCCitationHit[];
  };
}

interface EuropePMCReferencesResponse {
  referencesArray?: {
    reference?: EuropePMCCitationHit[];
  };
}

interface EuropePMCSearchResponse {
  resultList?: {
    result?: Array<{
      citedByCount?: number;
    }>;
  };
}

async function resolveToPMID(id: ArticleId): Promise<string | null> {
  if (id.pmid) return id.pmid;

  const query = id.doi ? `DOI:"${id.doi}"` : id.pmcid ? `PMCID:${id.pmcid}` : null;
  if (!query) return null;

  try {
    const conn = connectionManager.getConnection('europepmc');
    const response = await withTimeout(
      conn.request(`/search?query=${encodeURIComponent(query)}&resulttype=lite&format=json&pageSize=1`),
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    ) as { resultList?: { result?: Array<{ pmid?: string }> } } | null;

    return response?.resultList?.result?.[0]?.pmid || null;
  } catch {
    return null;
  }
}

function transformHit(hit: EuropePMCCitationHit): CitationRecord {
  return {
    pmid: hit.pmid,
    pmcid: hit.pmcid,
    doi: hit.doi,
    title: hit.title,
    authors: hit.authorString ? hit.authorString.split(', ') : undefined,
    journal: hit.journalTitle,
    year: hit.pubYear ? parseInt(hit.pubYear, 10) : undefined,
    source: 'europepmc',
  };
}

export async function getForwardCitations(id: ArticleId, limit: number): Promise<CitationRecord[]> {
  const pmid = await resolveToPMID(id);
  if (!pmid) return [];

  const idPath = `MED/${pmid}`;

  // Request buffer to account for items without IDs
  const requestPageSize = Math.max(limit * 3, 10);

  try {
    const conn = connectionManager.getConnection('europepmc');
    const response = await withTimeout(
      conn.request(`/${idPath}/citations?format=json&pageSize=${requestPageSize}`) as Promise<EuropePMCCitationsResponse>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response) return [];
    return (response.citationsArray?.citation || [])
      .filter((hit: EuropePMCCitationHit) => hit.pmid || hit.pmcid || hit.doi)
      .map(transformHit)
      .slice(0, limit);
  } catch (error) {
    console.error('[europepmc/getForwardCitations] Error:', error);
    return [];
  }
}

export async function getBackwardReferences(id: ArticleId, limit: number, articleYear?: number): Promise<CitationRecord[]> {
  const pmid = await resolveToPMID(id);
  if (!pmid) return [];

  const idPath = `PMID/${pmid}`;

  // Request buffer to account for items without IDs and year filtering
  const requestPageSize = Math.max(limit * 3, 10);

  try {
    const conn = connectionManager.getConnection('europepmc');
    const response = await withTimeout(
      conn.request(`/${idPath}/references?format=json&pageSize=${requestPageSize}`) as Promise<EuropePMCReferencesResponse>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response) return [];
    let records = (response.referencesArray?.reference || [])
      .filter((hit: EuropePMCCitationHit) => hit.pmid || hit.pmcid || hit.doi)
      .map(transformHit);

    // Filter backward references by publication year: only include items
    // published in the same year or earlier than the source article
    if (articleYear !== undefined) {
      records = records.filter((record: CitationRecord) =>
        record.year === undefined || record.year <= articleYear
      );
    }
    return records.slice(0, limit);
  } catch (error) {
    console.error('[europepmc/getBackwardReferences] Error:', error);
    return [];
  }
}

export async function getCitationCount(id: ArticleId): Promise<CitationCount | null> {
  const pmid = await resolveToPMID(id);
  if (!pmid) return null;

  const query = `PMID:${pmid}`;

  try {
    const conn = connectionManager.getConnection('europepmc');
    const response = await withTimeout(
      conn.request(`/search?query=${encodeURIComponent(query)}&resulttype=lite&format=json&pageSize=1`) as Promise<EuropePMCSearchResponse>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response) return null;
    const count = response.resultList?.result?.[0]?.citedByCount;
    if (count === undefined) return null;

    return { total: count, source: 'europepmc' };
  } catch (error) {
    console.error('[europepmc/getCitationCount] Error:', error);
    return null;
  }
}

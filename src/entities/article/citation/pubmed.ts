import { connectionManager } from '../../../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import type { ArticleId, CitationRecord, CitationCount } from './types.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../../connections/fetch-utils.js';

interface PubMedLinkResponse {
  linksets?: Array<{
    linksetdbs?: Array<{
      linkname: string;
      links?: Array<string | { id: string }>;
    }>;
  }>;
}

function extractLinks(response: PubMedLinkResponse, linkName: string): string[] {
  return response.linksets?.[0]?.linksetdbs
    ?.find((l: { linkname: string }) => l.linkname === linkName)
    ?.links?.map((l: string | { id: string }) => typeof l === 'string' ? l : l.id) || [];
}

const citedInCache = new Map<string, { promise: Promise<string[]>; cleanup: ReturnType<typeof setTimeout> }>();

async function fetchCitedInLinks(pmid: string): Promise<string[]> {
  const conn = connectionManager.getConnection('pubmed');
  const response = await withTimeout(
    conn.request(`/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_citedin&id=${pmid}&retmode=json`) as Promise<PubMedLinkResponse>,
    DEFAULT_PROVIDER_TIMEOUT_MS,
    { onTimeout: 'null' }
  );
  if (!response) return [];
  return extractLinks(response, 'pubmed_pubmed_citedin');
}

function getCachedCitedInLinks(pmid: string): Promise<string[]> {
  if (!citedInCache.has(pmid)) {
    const promise = fetchCitedInLinks(pmid);
    const cleanup = setTimeout(() => citedInCache.delete(pmid), 30000);
    if (cleanup.unref) cleanup.unref();
    citedInCache.set(pmid, { promise, cleanup });
  }
  return citedInCache.get(pmid)!.promise;
}

export function clearCitedInCache(): void {
  for (const entry of citedInCache.values()) {
    clearTimeout(entry.cleanup);
  }
  citedInCache.clear();
}

async function enrichPmids(pmids: string[]): Promise<Map<string, CitationRecord>> {
  const recordMap = new Map<string, CitationRecord>();
  if (pmids.length === 0) return recordMap;

  try {
    const conn = connectionManager.getConnection('pubmed');
    const xmlString = await withTimeout(
      conn.request(`/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&rettype=abstract`) as Promise<string>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!xmlString) return recordMap;
    const articles = parsePubMedXml(xmlString);
    for (const article of articles) {
      if (article.pmid) {
        recordMap.set(article.pmid, {
          pmid: article.pmid,
          doi: article.doi,
          title: article.title,
          authors: article.authors,
          journal: article.journal,
          year: article.publication_date ? extractYear(article.publication_date) : undefined,
          source: 'pubmed',
        });
      }
    }
  } catch (error) {
    console.error('[pubmed/enrichPmids] Error:', error);
  }

  return recordMap;
}

function extractYear(dateStr: string): number | undefined {
  const match = dateStr.match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : undefined;
}

export async function getForwardCitations(id: ArticleId, limit: number): Promise<CitationRecord[]> {
  if (!id.pmid) return [];

  try {
    const links = await getCachedCitedInLinks(id.pmid);
    const sliced = links.slice(0, limit);

    const enriched = await enrichPmids(sliced);
    return sliced.map((pmid: string) =>
      enriched.get(pmid) || { pmid, source: 'pubmed' }
    );
  } catch (error) {
    console.error('[pubmed/getForwardCitations] Error:', error);
    return [];
  }
}

export async function getBackwardReferences(id: ArticleId, limit: number, articleYear?: number): Promise<CitationRecord[]> {
  if (!id.pmid) return [];

  // Request buffer for year filtering - fetch extra PMIDs since we'll filter by year
  const fetchLimit = articleYear !== undefined ? Math.max(limit * 3, 10) : limit;

  try {
    const conn = connectionManager.getConnection('pubmed');

    const response = await withTimeout(
      conn.request(`/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_refs&id=${id.pmid}&retmode=json`) as Promise<PubMedLinkResponse>,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      { onTimeout: 'null' }
    );

    if (!response) return [];
    const links = extractLinks(response, 'pubmed_pubmed_refs').slice(0, fetchLimit);

    const enriched = await enrichPmids(links);
    let records = links.map((pmid: string) =>
      enriched.get(pmid) || { pmid, source: 'pubmed' }
    );

    // Filter backward references by publication year: only include items
    // published in the same year or earlier than the source article
    if (articleYear !== undefined) {
      records = records.filter((record: CitationRecord) =>
        record.year === undefined || record.year <= articleYear
      );
    }
    return records.slice(0, limit);
  } catch (error) {
    console.error('[pubmed/getBackwardReferences] Error:', error);
    return [];
  }
}

export async function getCitationCount(id: ArticleId): Promise<CitationCount | null> {
  if (!id.pmid) return null;

  try {
    const links = await getCachedCitedInLinks(id.pmid);
    if (links.length === 0) return null;

    return { total: links.length, source: 'pubmed' };
  } catch (error) {
    console.error('[pubmed/getCitationCount] Error:', error);
    return null;
  }
}

import { connectionManager } from '../../../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import type { Article, ParsedDateRange } from '../types.js';
import { withRetry } from '../../../connections/retry.js';

interface PubMedSearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

export function formatPubMedDate(isoDate: string): string {
  return isoDate.replace(/-/g, '/');
}

const PUBMED_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 500,
  logger: { warn: (msg: string) => console.warn(`[pubmed] ${msg}`) }
};

export async function searchPubMed(query: string, limit: number, offset: number, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    let searchUrl = `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retstart=${offset}&retmode=json`;
    if (dateRange?.from || dateRange?.to) {
      searchUrl += `&datetype=pdat`;
      if (dateRange.from) searchUrl += `&mindate=${formatPubMedDate(dateRange.from)}`;
      if (dateRange.to) searchUrl += `&maxdate=${formatPubMedDate(dateRange.to)}`;
    }

    const searchResponse = await withRetry(
      async () => {
        const conn = connectionManager.getConnection('pubmed');
        return await conn.request(searchUrl) as PubMedSearchResponse;
      },
      PUBMED_RETRY_CONFIG
    );

    if (!searchResponse.esearchresult?.idlist?.length) return [];

    const ids = searchResponse.esearchresult.idlist.join(',');
    const xmlString = await withRetry(
      async () => {
        const conn = connectionManager.getConnection('pubmed');
        return await conn.request(
          `/efetch.fcgi?db=pubmed&id=${ids}&rettype=abstract`
        ) as string;
      },
      PUBMED_RETRY_CONFIG
    );

    return parsePubMedXml(xmlString);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchPubMed] Error:', error);
    return [{ _error: `searchPubMed failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

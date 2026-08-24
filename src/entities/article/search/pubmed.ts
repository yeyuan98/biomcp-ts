import { connectionManager } from '../../../connections/manager.js';
import { parsePubMedXml } from '../transform/pubmed.js';
import type { Article, ParsedDateRange } from '../types.js';

interface PubMedSearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

export function formatPubMedDate(isoDate: string): string {
  return isoDate.replace(/-/g, '/');
}

export async function searchPubMed(query: string, limit: number, offset: number, dateRange?: ParsedDateRange): Promise<Article[]> {
  try {
    let searchUrl = `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retstart=${offset}&retmode=json`;
    if (dateRange?.from || dateRange?.to) {
      // NBK25499: mindate/maxdate must be used together — default the
      // missing bound so esearch always receives a complete range.
      searchUrl += `&datetype=pdat`;
      searchUrl += `&mindate=${dateRange.from ? formatPubMedDate(dateRange.from) : '1600/01/01'}`;
      searchUrl += `&maxdate=${dateRange.to ? formatPubMedDate(dateRange.to) : '3000/12/31'}`;
    }

    // Retry policy lives on the registry 'eutils' source config.
    const conn = connectionManager.getConnection('eutils');
    const searchResponse = await conn.request(searchUrl) as PubMedSearchResponse;

    if (!searchResponse.esearchresult?.idlist?.length) return [];

    const ids = searchResponse.esearchresult.idlist.join(',');
    const xmlString = await conn.request(
      `/efetch.fcgi?db=pubmed&id=${ids}&rettype=abstract`
    ) as string;

    return parsePubMedXml(xmlString);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[searchPubMed] Error:', error);
    return [{ _error: `searchPubMed failed: ${msg}. This may be a temporary data source issue. Try again or use a different source.` } as any];
  }
}

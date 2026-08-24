import { connectionManager } from '../../../connections/manager.js';

interface BioCJSONResponse {
  PubTator3?: BioCJSONArticle[];
}

interface BioCJSONArticle {
  passages?: Array<{
    text?: string;
    annotations?: Array<{
      infons?: { type?: string; identifier?: string };
      text: string;
      locations?: Array<{ offset: number; length: number }>;
    }>;
  }>;
}

interface PubMedLinkResponse {
  linksets?: Array<{
    linksetdbs?: Array<{
      linkname: string;
      links?: Array<string | { id: string }>;
    }>;
  }>;
}

export async function fetchAnnotations(pmid: string): Promise<Array<{ type: string; text: string; start: number; end: number }>> {
  try {
    const conn = connectionManager.getConnection('pubtator');

    const response = await conn.request(
      `/publications/export/biocjson?pmids=${pmid}`
    ) as BioCJSONResponse;

    let items: BioCJSONArticle[] = [];

    const rawItems = response?.PubTator3 ?? response;
    if (Array.isArray(rawItems)) {
      items = rawItems;
    } else if (rawItems && typeof rawItems === 'object') {
      const wrapper = rawItems as Record<string, unknown>;
      for (const key of Object.keys(wrapper)) {
        if (Array.isArray(wrapper[key])) {
          items = wrapper[key] as BioCJSONArticle[];
          break;
        }
      }
    }

    const annotations: Array<{ type: string; text: string; start: number; end: number }> = [];
    for (const article of items) {
      for (const passage of (article.passages || [])) {
        for (const ann of (passage.annotations || [])) {
          annotations.push({
            type: ann.infons?.type || 'unknown',
            text: ann.text,
            start: ann.locations?.[0]?.offset ?? 0,
            end: (ann.locations?.[0]?.offset ?? 0) + (ann.locations?.[0]?.length ?? 0),
          });
        }
      }
    }

    return annotations;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchAnnotations] Error:', error);
    let hint = ' The data source may be temporarily unavailable.';
    if (msg.includes('400')) {
      hint = ' This article may not yet be indexed by PubTator. Try an older article with an established PMID.';
    } else if (msg.includes('429')) {
      hint = ' Rate limited by PubTator. Wait a few seconds and retry.';
    }
    return [{ _error: `Annotation lookup failed (source: pubtator): ${msg}.${hint}` } as any];
  }
}

export async function fetchCitationGraph(pmid: string): Promise<{ citations?: string[]; references?: string[] }> {
  try {
    const conn = connectionManager.getConnection('eutils');

    const [citedInResponse, refsResponse] = await Promise.all([
      conn.request(
        `/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_citedin&id=${pmid}&retmode=json`
      ) as Promise<PubMedLinkResponse>,
      conn.request(
        `/elink.fcgi?dbfrom=pubmed&linkname=pubmed_pubmed_refs&id=${pmid}&retmode=json`
      ) as Promise<PubMedLinkResponse>,
    ]);

    const citations = citedInResponse.linksets?.[0]?.linksetdbs
      ?.find((l: { linkname: string }) => l.linkname === 'pubmed_pubmed_citedin')
      ?.links?.map((l: string | { id: string }) => typeof l === 'string' ? l : l.id) || [];

    const references = refsResponse.linksets?.[0]?.linksetdbs
      ?.find((l: { linkname: string }) => l.linkname === 'pubmed_pubmed_refs')
      ?.links?.map((l: string | { id: string }) => typeof l === 'string' ? l : l.id) || [];

    return { citations, references };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchCitationGraph] Error:', error);
    let hint = ' The data source may be temporarily unavailable.';
    if (msg.includes('429')) {
      hint = ' Rate limited by PubMed E-utilities. Wait a few seconds and retry. If persistent, set NCBI_API_KEY for higher rate limits.';
    } else if (msg.includes('400')) {
      hint = ' The PMID may not be recognized by PubMed E-utilities. Verify the PMID is correct.';
    }
    return { _error: `Citation graph lookup failed (source: pubmed): ${msg}.${hint}` } as any;
  }
}

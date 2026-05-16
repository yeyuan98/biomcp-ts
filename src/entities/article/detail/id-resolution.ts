import { connectionManager } from '../../../connections/manager.js';

interface PubMedSearchResponse {
  esearchresult?: {
    idlist?: string[];
  };
}

export interface ResolvedPmid {
  pmid: string;
  pmcid?: string;
  doi?: string;
}

export interface IDConvResponse {
  status?: string;
  records?: Array<{
    doi?: string;
    pmcid?: string;
    pmid?: number;
    requestedId?: string;
    status?: string;
    errmsg?: string;
  }>;
}

export function parseArticleId(id: string): { type: 'pmid' | 'pmcid' | 'doi'; value: string } {
  const trimmed = id.trim();
  if (/^\d+$/.test(trimmed)) return { type: 'pmid', value: trimmed };
  if (/^PMC\d+$/i.test(trimmed)) return { type: 'pmcid', value: trimmed };
  const doiMatch = trimmed.match(/^(?:doi:)?(10\.\d{4,}\/\S+)$/i);
  if (doiMatch) return { type: 'doi', value: doiMatch[1] };
  throw new Error(`Unrecognized identifier format: "${id}". Expected PMID (numeric), PMCID (PMC...), or DOI (10.x/...).`);
}

export async function resolveToPmid(id: string, type: 'doi' | 'pmcid'): Promise<ResolvedPmid> {
  try {
    const conn = connectionManager.getConnection('ncbi_idconv');

    const response = await conn.request(
      `?ids=${encodeURIComponent(id)}&format=json`
    ) as IDConvResponse;

    const record = response.records?.[0];
    if (!record) {
      throw new Error(`No record returned for ${type}: "${id}". The identifier may not exist in the NCBI database.`);
    }
    if (record.errmsg || record.status === 'error') {
      throw new Error(`Could not resolve ${type} "${id}": ${record.errmsg || 'Unknown error'}.`);
    }
    if (!record.pmid) {
      throw new Error(`Could not resolve ${type} "${id}" to a PMID. The article may not be indexed in PubMed.`);
    }

    return {
      pmid: String(record.pmid),
      pmcid: record.pmcid,
      doi: record.doi,
    };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Could not resolve') || error.message.startsWith('No record'))) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[resolveToPmid] Error:', error);
    throw new Error(`ID resolution failed (source: ncbi_idconv): ${msg}. The data source may be temporarily unavailable.`);
  }
}

export async function resolveDoiToPmid(doi: string): Promise<ResolvedPmid> {
  try {
    const conn = connectionManager.getConnection('pubmed');

    const searchResponse = await conn.request(
      `/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json&retmax=1`
    ) as PubMedSearchResponse;

    const pmid = searchResponse.esearchresult?.idlist?.[0];
    if (!pmid) {
      throw new Error(`Could not resolve doi "${doi}" to a PMID. The DOI may not be indexed in PubMed.`);
    }

    return { pmid, doi };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Could not resolve')) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[resolveDoiToPmid] Error:', error);
    throw new Error(`DOI resolution failed (source: pubmed): ${msg}. The data source may be temporarily unavailable.`);
  }
}

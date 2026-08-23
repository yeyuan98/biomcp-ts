import { connectionManager } from '../connections/manager.js';

/** Bounded pagination: /gda/summary pages are small, so fetch at most two
 *  pages per call and stop early once enough rows for the ~20-row sections
 *  have accumulated. */
const MAX_PAGES = 2;
const TARGET_ROWS = 20;

/**
 * DisGeNET /gda/summary accepts disease codes in underscore-prefixed
 * vocabulary form (e.g. `UMLS_C0006142`, `MONDO_0007254`, `DO_1612`), not
 * free text. Bare UMLS CUIs and colon-form IDs are normalized; unknown
 * formats pass through unchanged for the API to accept or reject.
 */
export function toDisgenetDiseaseCode(diseaseId: string): string {
  if (/^C\d+$/.test(diseaseId)) return `UMLS_${diseaseId}`;
  const match = diseaseId.match(/^([A-Za-z]+)[:_]([A-Za-z0-9._-]+)$/);
  if (match) {
    const vocab = match[1].toUpperCase() === 'DOID' ? 'DO' : match[1].toUpperCase();
    return `${vocab}_${match[2]}`;
  }
  return diseaseId;
}

export interface DisgenetGdaRow {
  gene_symbol?: string;
  gene_ncbi_id?: number;
  disease_name?: string;
  disease_id?: string;
  score?: number;
  pmids?: number;
}

interface DisgenetSummaryResponse {
  payload?: Array<{
    symbolOfGene?: string;
    geneNcbiID?: number;
    diseaseName?: string;
    diseaseUMLSCUI?: string;
    score?: number;
    numPMIDs?: number;
  }>;
  pageCount?: number;
}

/**
 * Query DisGeNET `/gda/summary` by gene symbol and/or disease code.
 * Throws on HTTP errors; callers own error shaping (`_error` rows/objects).
 */
export async function fetchDisgenetGdaSummary(
  params: { disease?: string; gene_symbol?: string },
  signal?: AbortSignal
): Promise<DisgenetGdaRow[]> {
  const conn = connectionManager.getConnection('disgenet');

  const query = new URLSearchParams();
  if (params.disease) query.set('disease', toDisgenetDiseaseCode(params.disease));
  if (params.gene_symbol) query.set('gene_symbol', params.gene_symbol);

  const rows: DisgenetGdaRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    query.set('page_number', String(page));
    const response = await conn.request(
      `/gda/summary?${query.toString()}`,
      undefined,
      signal ? { signal } : undefined
    ) as DisgenetSummaryResponse;
    const payload = response.payload || [];
    rows.push(...payload.map(p => ({
      gene_symbol: p.symbolOfGene,
      gene_ncbi_id: p.geneNcbiID,
      disease_name: p.diseaseName,
      disease_id: p.diseaseUMLSCUI,
      score: p.score,
      pmids: p.numPMIDs,
    })));
    if (payload.length === 0) break;
    if (rows.length >= TARGET_ROWS) break;
    if (response.pageCount !== undefined && page + 1 >= response.pageCount) break;
  }
  return rows;
}

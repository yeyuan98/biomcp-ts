import { connectionManager } from '../connections/manager.js';
import { isRetryableError } from '../connections/retry.js';
import { errorMessageWithCause } from './errors.js';

const PINNED_DATASET_ID = 'gtex_v10';
const PINNED_GENCODE_VERSION = 'v39';
const GENE_SEARCH_MAX_PAGES = 2;
const DEFAULT_EQTL_LIMIT = 20;
const MAX_EQTL_LIMIT = 100;
const NOTE_TOP_TISSUES = 5;

export interface GTExDatasetInfo {
  datasetId: string;
  displayName: string;
  gencodeVersion: string;
  genomeBuild: string;
  description?: string;
  tissueCount?: number;
  rnaSeqSampleCount?: number;
  subjectCount?: number;
}

export interface GTExTissueInfo {
  tissueSiteDetailId: string;
  tissueSiteDetail: string;
  tissueSiteDetailAbbr: string;
  ontologyId: string;
  eGeneCount: number;
}

export interface GTExMedianTissueExpression {
  tissue: string;
  median_tpm: number;
  ontology_id: string;
}

export interface GTExMedianExpressionResult {
  gene_symbol: string;
  gencode_id: string;
  dataset: string;
  unit: string;
  tissues: GTExMedianTissueExpression[];
}

export interface GTExEqtlAssociation {
  variant_id: string;
  p_value: number;
  nes: number;
}

export interface GTExEqtlResult {
  gene_symbol: string;
  gencode_id: string;
  tissue: string;
  associations: GTExEqtlAssociation[];
  /** Advisory context attached only when `associations` is empty: distinguishes
   *  "gene tested, nothing significant in this tissue" from a mapping failure,
   *  and lists other tissues where significant eQTLs do exist (#106). */
  note?: string;
}

export interface GencodeIdResolution {
  gencodeId: string;
  geneSymbol: string;
  entrezGeneId?: number;
}

/** Structured failure envelope for the gtex entry points (house `_error`
 *  pattern, cf. cross-entity): upstream failures surface as DATA instead of
 *  a raw `HttpConnectionError` throw, so the tool layer stringifies a
 *  source-attributed, remedy-carrying message with an explicit retry
 *  classification (#132). `retryable` mirrors the connection layer's
 *  classifier: network/transport failures and 5xx (and 429) are transient;
 *  deterministic 4xx and validation errors are not. */
export interface GTExErrorEnvelope {
  _error: string;
  source: 'gtex';
  retryable: boolean;
}

function gtexErrorEnvelope(error: unknown): GTExErrorEnvelope {
  const retryable = isRetryableError(error);
  const remedy = retryable
    ? 'Usually transient — retry once or twice, or try later.'
    : 'Check the gene symbol, tissue ID, and request parameters, then retry.';
  return {
    _error: `GTEx request failed: ${errorMessageWithCause(error)}. ${remedy}`,
    source: 'gtex',
    retryable,
  };
}

interface DatasetMetadataItem {
  datasetId: string;
  displayName?: string;
  gencodeVersion?: string;
  genomeBuild?: string;
  description?: string;
  tissueCount?: number;
  rnaSeqSampleCount?: number;
  subjectCount?: number;
}

interface GeneSearchResponse {
  data?: Array<{
    gencodeId?: string;
    geneSymbol?: string;
    geneSymbolUpper?: string;
    entrezGeneId?: number;
  }>;
  paging_info?: {
    numberOfPages?: number;
  };
}

interface MedianExpressionResponse {
  data?: Array<{
    median: number;
    tissueSiteDetailId: string;
    ontologyId?: string;
    unit?: string;
  }>;
}

interface SingleTissueEqtlResponse {
  data?: Array<{
    variantId: string;
    pValue: number;
    nes: number;
    tissueSiteDetailId?: string;
  }>;
}

interface TissueSiteDetailResponse {
  data?: Array<{
    tissueSiteDetailId: string;
    tissueSiteDetail: string;
    tissueSiteDetailAbbr?: string;
    ontologyId?: string;
    eGeneCount?: number;
  }>;
}

interface ActiveDataset {
  datasetId: string;
  gencodeVersion: string;
}

let datasetsMemo: Promise<GTExDatasetInfo[]> | null = null;
let activeDatasetMemo: Promise<ActiveDataset> | null = null;
let activeDatasetMemoAt = 0;
const ACTIVE_DATASET_TTL_MS = 10 * 60 * 1000;
let tissuesMemo: Promise<GTExTissueInfo[]> | null = null;
const GENCODE_MEMO_MAX = 500;
const gencodeIdMemo = new Map<string, Promise<GencodeIdResolution>>();

function rememberGencodeId(key: string, promise: Promise<GencodeIdResolution>): void {
  if (gencodeIdMemo.size >= GENCODE_MEMO_MAX) {
    const oldest = gencodeIdMemo.keys().next().value;
    if (oldest !== undefined) gencodeIdMemo.delete(oldest);
  }
  gencodeIdMemo.set(key, promise);
}

export function getGtexDatasets(): Promise<GTExDatasetInfo[]> {
  if (!datasetsMemo) {
    datasetsMemo = fetchDatasets().catch(error => {
      datasetsMemo = null;
      throw error;
    });
  }
  return datasetsMemo;
}

async function fetchDatasets(): Promise<GTExDatasetInfo[]> {
  const conn = connectionManager.getConnection('gtex');
  const response = await conn.request('/api/v2/metadata/dataset') as unknown;
  if (!Array.isArray(response)) {
    throw new Error('Unexpected GTEx metadata/dataset response shape');
  }
  return (response as DatasetMetadataItem[]).map(d => ({
    datasetId: d.datasetId,
    displayName: d.displayName ?? d.datasetId,
    gencodeVersion: d.gencodeVersion ?? '',
    genomeBuild: d.genomeBuild ?? '',
    description: d.description,
    tissueCount: d.tissueCount,
    rnaSeqSampleCount: d.rnaSeqSampleCount,
    subjectCount: d.subjectCount,
  }));
}

/** Latest gtex_vN release derived from metadata; NB: kids_first_harmonization
 *  and other non-GTEx datasets must stay excluded from the comparison. */
async function getActiveDataset(): Promise<ActiveDataset> {
  if (!activeDatasetMemo || Date.now() - activeDatasetMemoAt > ACTIVE_DATASET_TTL_MS) {
    activeDatasetMemoAt = Date.now();
    activeDatasetMemo = (async () => {
      try {
        const datasets = await getGtexDatasets();
        const gtexReleases = datasets
          .filter(d => /^gtex_v\d+$/.test(d.datasetId))
          .sort((a, b) => datasetVersion(b.datasetId) - datasetVersion(a.datasetId));
        const latest = gtexReleases[0];
        if (latest?.gencodeVersion) {
          return { datasetId: latest.datasetId, gencodeVersion: latest.gencodeVersion };
        }
      } catch {
        // Metadata unavailable — pinned fallback keeps requests servable.
      }
      return { datasetId: PINNED_DATASET_ID, gencodeVersion: PINNED_GENCODE_VERSION };
    })();
  }
  return activeDatasetMemo;
}

function datasetVersion(datasetId: string): number {
  const match = datasetId.match(/^gtex_v(\d+)$/);
  return match ? Number(match[1]) : -1;
}

/** Resolve an HGNC symbol or ENSG (versioned or bare) to a versioned gencodeId.
 *  NB: unversioned ENSG yields empty data with HTTP 200 from expression
 *  endpoints, so callers must always use the versioned ID returned here. */
export function resolveGencodeId(geneIdentifier: string): Promise<GencodeIdResolution> {
  const key = geneIdentifier.trim().toUpperCase();
  const cached = gencodeIdMemo.get(key);
  if (cached) {
    gencodeIdMemo.delete(key);
    gencodeIdMemo.set(key, cached);
    return cached;
  }
  const promise = resolveGencodeIdUncached(geneIdentifier.trim()).catch(error => {
    gencodeIdMemo.delete(key);
    throw error;
  });
  rememberGencodeId(key, promise);
  return promise;
}

async function resolveGencodeIdUncached(identifier: string): Promise<GencodeIdResolution> {
  const conn = connectionManager.getConnection('gtex');
  const { datasetId, gencodeVersion } = await getActiveDataset();

  if (/^ENSG\d+/.test(identifier)) {
    const query = new URLSearchParams({ geneId: identifier, gencodeVersion });
    const response = await conn.request(`/api/v2/reference/geneSearch?${query.toString()}`) as GeneSearchResponse;
    const hit = (Array.isArray(response.data) ? response.data : [])[0];
    if (!hit?.gencodeId) {
      // NB: versioned ENSGs go stale between GENCODE releases; the bare form
      // always resolves to the current version (verified live).
      const hint = identifier.includes('.')
        ? ` — try the unversioned form ${identifier.split('.')[0]}`
        : '';
      throw new Error(notFoundInDataset(identifier, datasetId).message + hint);
    }
    return toResolution(hit);
  }

  // NB: symbol queries are prefix-fuzzy (TP53 also returns TP53BP2 etc), so an
  // exact geneSymbolUpper match must be found, potentially on later pages.
  const upper = identifier.toUpperCase();
  for (let page = 0; page < GENE_SEARCH_MAX_PAGES; page++) {
    const query = new URLSearchParams({ geneId: identifier, gencodeVersion, page: String(page) });
    const response = await conn.request(`/api/v2/reference/geneSearch?${query.toString()}`) as GeneSearchResponse;
    const rows = Array.isArray(response.data) ? response.data : [];
    const hit = rows.find(g => g.geneSymbolUpper === upper);
    if (hit?.gencodeId) {
      return toResolution(hit);
    }
    const numberOfPages = response.paging_info?.numberOfPages ?? 1;
    if (page + 1 >= Math.min(numberOfPages, GENE_SEARCH_MAX_PAGES)) break;
  }
  throw notFoundInDataset(identifier, datasetId);
}

function toResolution(hit: NonNullable<GeneSearchResponse['data']>[number]): GencodeIdResolution {
  return {
    gencodeId: hit.gencodeId!,
    geneSymbol: hit.geneSymbol ?? '',
    entrezGeneId: hit.entrezGeneId,
  };
}

function notFoundInDataset(identifier: string, datasetId: string): Error {
  return new Error(`Gene '${identifier}' not found in GTEx ${datasetId.replace(/^gtex_/, '')} gene reference`);
}

export async function gtexMedianExpression(
  geneIdentifier: string,
  options: { tissueSiteDetailId?: string; limit?: number } = {}
): Promise<GTExMedianExpressionResult | GTExErrorEnvelope> {
  try {
    const conn = connectionManager.getConnection('gtex');
    const resolution = await resolveGencodeId(geneIdentifier);
    const { datasetId } = await getActiveDataset();

    const query = new URLSearchParams({ gencodeId: resolution.gencodeId, datasetId });
    if (options.tissueSiteDetailId) query.set('tissueSiteDetailId', options.tissueSiteDetailId);

    const response = await conn.request(`/api/v2/expression/medianGeneExpression?${query.toString()}`) as MedianExpressionResponse;
    const rows = Array.isArray(response.data) ? response.data : [];
    const sorted = rows.slice().sort((a, b) => b.median - a.median);
    const limit = options.limit !== undefined ? Math.max(0, options.limit) : sorted.length;

    return {
      gene_symbol: resolution.geneSymbol,
      gencode_id: resolution.gencodeId,
      dataset: datasetId,
      unit: rows[0]?.unit ?? 'TPM',
      tissues: sorted.slice(0, limit).map(r => ({
        tissue: r.tissueSiteDetailId,
        median_tpm: r.median,
        ontology_id: r.ontologyId ?? '',
      })),
    };
  } catch (error) {
    return gtexErrorEnvelope(error);
  }
}

export async function gtexEqtl(
  geneIdentifier: string,
  tissueSiteDetailId: string,
  options: { limit?: number } = {}
): Promise<GTExEqtlResult | GTExErrorEnvelope> {
  try {
    const conn = connectionManager.getConnection('gtex');
    const { datasetId } = await getActiveDataset();

    const tissues = await getGtexTissues();
    if (!tissues.some(t => t.tissueSiteDetailId === tissueSiteDetailId)) {
      throw new Error(
        `Invalid tissue '${tissueSiteDetailId}'. Use gtex tissues like 'Brain_Cortex', 'Whole_Blood' — see dataset/tissueSiteDetail (${tissues.length} tissues in ${datasetId})`
      );
    }

    const resolution = await resolveGencodeId(geneIdentifier);
    const query = new URLSearchParams({
      gencodeId: resolution.gencodeId,
      datasetId,
      tissueSiteDetailId,
    });
    const response = await conn.request(`/api/v2/association/singleTissueEqtl?${query.toString()}`) as SingleTissueEqtlResponse;

    // NB: empty data with HTTP 200 is legitimate (no significant eQTLs).
    const rows = Array.isArray(response.data) ? response.data : [];
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_EQTL_LIMIT, 1), MAX_EQTL_LIMIT);

    // An empty list for a valid gene+tissue is a valid scientific result, but is
    // indistinguishable from a gene/dataset mapping failure at a glance (#106).
    // Attach an advisory note: one extra all-tissues query (same gencodeId +
    // datasetId) lists where significant eQTLs DO exist. Diagnostic-only — if
    // the extra call itself fails, return the plain empty result.
    let note: string | undefined;
    if (rows.length === 0) {
      note = await buildEmptyEqtlNote(conn, resolution.geneSymbol || geneIdentifier, resolution.gencodeId, datasetId, tissueSiteDetailId);
    }

    const associations = rows
      .slice()
      .sort((a, b) => a.pValue - b.pValue)
      .map(r => ({
        variant_id: r.variantId,
        p_value: r.pValue,
        nes: r.nes,
      }));

    return {
      gene_symbol: resolution.geneSymbol,
      gencode_id: resolution.gencodeId,
      tissue: tissueSiteDetailId,
      associations: associations.slice(0, limit),
      ...(note !== undefined ? { note } : {}),
    };
  } catch (error) {
    return gtexErrorEnvelope(error);
  }
}

/** Query every tissue for the gene and render the "no eQTLs here, but N
 *  elsewhere" / "no eQTLs anywhere" advisory note. Never throws. */
async function buildEmptyEqtlNote(
  conn: ReturnType<typeof connectionManager.getConnection>,
  geneSymbol: string,
  gencodeId: string,
  datasetId: string,
  queriedTissue: string
): Promise<string | undefined> {
  try {
    const query = new URLSearchParams({ gencodeId, datasetId });
    const response = await conn.request(`/api/v2/association/singleTissueEqtl?${query.toString()}`) as SingleTissueEqtlResponse;
    const rows = Array.isArray(response.data) ? response.data : [];

    const counts = new Map<string, number>();
    for (const row of rows) {
      const tissue = row.tissueSiteDetailId;
      if (!tissue || tissue === queriedTissue) continue;
      counts.set(tissue, (counts.get(tissue) ?? 0) + 1);
    }

    const release = datasetId.replace(/^gtex_/, '');
    if (counts.size === 0) {
      return `${geneSymbol} has no significant cis-eQTLs in any GTEx ${release} tissue`;
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, count]) => sum + count, 0);
    const listed = ranked
      .slice(0, NOTE_TOP_TISSUES)
      .map(([tissue, count]) => `${tissue} (${count})`);
    const remaining = ranked.length - listed.length;
    if (remaining > 0) listed.push(`and ${remaining} more`);
    return `${geneSymbol} has no significant cis-eQTLs in ${queriedTissue} in GTEx ${release}, but has ${total} in other tissues: ${listed.join(', ')}`;
  } catch {
    return undefined;
  }
}

export function getGtexTissues(): Promise<GTExTissueInfo[]> {
  if (!tissuesMemo) {
    tissuesMemo = fetchTissues().catch(error => {
      tissuesMemo = null;
      throw error;
    });
  }
  return tissuesMemo;
}

async function fetchTissues(): Promise<GTExTissueInfo[]> {
  const conn = connectionManager.getConnection('gtex');
  const { datasetId } = await getActiveDataset();
  const query = new URLSearchParams({ datasetId });
  const response = await conn.request(`/api/v2/dataset/tissueSiteDetail?${query.toString()}`) as TissueSiteDetailResponse;
  return (Array.isArray(response.data) ? response.data : []).map(t => ({
    tissueSiteDetailId: t.tissueSiteDetailId,
    tissueSiteDetail: t.tissueSiteDetail,
    tissueSiteDetailAbbr: t.tissueSiteDetailAbbr ?? '',
    ontologyId: t.ontologyId ?? '',
    eGeneCount: t.eGeneCount ?? 0,
  }));
}

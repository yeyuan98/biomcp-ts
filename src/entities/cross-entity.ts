import { connectionManager } from '../connections/manager.js';
import { RestConnection } from '../connections/rest.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';
import { geneSearch, GeneSearchResult } from './gene.js';
import { variantSearch, VariantSearchResult } from './variant.js';
import { drugSearch, DrugSearchResult, drugIdentityKey, fetchAdverseEvents, AdverseEventsResult } from './drug.js';
import { diseaseSearch, DiseaseSearchResult } from './disease.js';
import { trialSearch } from './trial.js';
import { articleSearch, Article } from './article/index.js';
import { fetchDisgenetGdaSummary } from './disgenet.js';
import { errorMessageWithCause, networkCauseCode } from './errors.js';

const SECTION_TIMEOUT_MS = 8000;

// ============================================================
// OpenTargets drug-candidate ranking (shared by geneToDrugs and
// diseaseToDrugs). The v4 drugAndClinicalCandidates connection
// exposes no orderBy and no approved flag, so ranking is client-side.
// ============================================================

/** Row shape of the drugAndClinicalCandidates connection (both directions). */
interface OtDrugCandidateRow {
  maxClinicalStage?: string;
  clinicalReports?: Array<{ id?: string }>;
  drug?: { id?: string; name?: string; drugType?: string };
}

/**
 * Numeric rank for an OpenTargets maxClinicalStage value; higher is more
 * clinically advanced. Observed live values (api.platform.opentargets.org,
 * schema v4) are uppercase underscore strings: 'APPROVAL', 'PHASE_4',
 * 'PHASE_3', 'PHASE_2_3', 'PHASE_2', 'PHASE_1_2', 'PHASE_1',
 * 'EARLY_PHASE_1', 'IND', 'UNKNOWN'. Normalization is deliberately robust
 * to case, spaces and 'Phase 3'-style display strings; the resulting order is:
 *
 *   approval/approved (7) > phase 4 (4) > phase 3 (3) > phase 2/3 (2.5) >
 *   phase 2 (2) > phase 1/2 (1.5) > phase 1 (1) > early phase 1 (0.75) >
 *   phase 0 / preclinical / IND (0.5) > unknown/unparsable (0)
 *
 * A phase range ('PHASE_1_2', 'Phase 2/3') ranks at its midpoint so it sits
 * strictly between its endpoints.
 */
function clinicalStageRank(stage: string | undefined): number {
  const norm = (stage ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!norm) return 0;
  if (norm.includes('approv') || norm.includes('launch')) return 7;
  const phases = (norm.match(/\d+/g) || []).map(Number);
  if (phases.length === 0) {
    // 'ind' (investigational new drug application) and 'preclinical' sit
    // just below early phase 1 but above unknown.
    if (norm === 'ind' || norm.includes('preclinical')) return 0.5;
    return 0;
  }
  let score = phases.reduce((sum, n) => sum + n, 0) / phases.length;
  if (norm.includes('early')) score -= 0.25;
  if (score <= 0) return 0.5; // phase 0 / preclinical tier
  return Math.min(score, 4);
}

/**
 * Rank OpenTargets drugAndClinicalCandidates rows before taking a top-N
 * slice (the API returns them unranked):
 * 1. Sort by (a) maxClinicalStage rank descending, (b) clinicalReports
 *    count descending, (c) drug name ascending case-insensitively as a
 *    deterministic tie-break.
 * 2. Salt-collapse rows sharing a drugIdentityKey (name-keyed here, so
 *    e.g. DABRAFENIB MESYLATE and DABRAFENIB keep only the single
 *    best-ranked row of the group).
 * The caller slices the returned list to its page size.
 */
function rankOtDrugRows(rows: OtDrugCandidateRow[]): OtDrugCandidateRow[] {
  const reportCount = (r: OtDrugCandidateRow) =>
    Array.isArray(r.clinicalReports) ? r.clinicalReports.length : 0;

  const sorted = [...rows].sort((a, b) => {
    const stageDiff = clinicalStageRank(b.maxClinicalStage) - clinicalStageRank(a.maxClinicalStage);
    if (stageDiff !== 0) return stageDiff;
    const reportDiff = reportCount(b) - reportCount(a);
    if (reportDiff !== 0) return reportDiff;
    const nameA = (a.drug?.name ?? '').toLowerCase();
    const nameB = (b.drug?.name ?? '').toLowerCase();
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return 0;
  });

  // First row seen in ranked order is the group's best; keep it.
  const byKey = new Map<string, OtDrugCandidateRow>();
  sorted.forEach((row, index) => {
    const name = (row.drug?.name ?? '').trim();
    // Nameless rows never collapse onto anything; they keep their sorted
    // position under unique per-index keys.
    const key = name ? drugIdentityKey({ name }) : `__noname_${index}`;
    if (!byKey.has(key)) byKey.set(key, row);
  });
  return [...byKey.values()];
}

export async function geneToDrugs(geneSymbol: string): Promise<Array<{ drug_name: string; source: string; action_type?: string; phase?: string; report_count?: number }>> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    
    const searchQuery = `query($symbol: String!) {
      search(queryString: $symbol, entityNames: ["target"], page: {index: 0, size: 1}) {
        hits { id name entity }
      }
    }`;
    
    const searchRaw = await conn.request(searchQuery, { symbol: geneSymbol }, { rootField: 'search' }) as any;
    const searchData = JSON.parse(JSON.stringify(searchRaw));
    const targetId = searchData?.data?.search?.hits?.[0]?.id;
    
    if (!targetId) {
      return [{ _error: `No OpenTargets entry found for gene '${geneSymbol}'. Verify the gene symbol using gene_search.` } as any];
    }
    
    const drugQuery = `query($ensemblId: String!) {
      target(ensemblId: $ensemblId) {
        drugAndClinicalCandidates {
          rows { maxClinicalStage clinicalReports { id } drug { id name drugType } }
        }
      }
    }`;

    const drugRaw = await conn.request(drugQuery, { ensemblId: targetId }, { rootField: 'target' }) as any;
    const drugData = JSON.parse(JSON.stringify(drugRaw));
    const rows: OtDrugCandidateRow[] = drugData?.data?.target?.drugAndClinicalCandidates?.rows || [];

    return rankOtDrugRows(rows).slice(0, 20).map((r) => ({
      drug_name: r.drug?.name || 'unknown',
      source: 'opentargets',
      action_type: r.drug?.drugType,
      phase: r.maxClinicalStage || undefined,
      report_count: (r.clinicalReports || []).length,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Drug lookup for gene failed (source: opentargets): ${msg}. Try gene_search first to verify the gene symbol, or try again later.` } as any];
  }
}

export async function geneToTrials(geneSymbol: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  const response = await trialSearch(geneSymbol, { limit: 10 });
  return response.studies.map(t => ({
    nct_id: t.nct_id,
    title: t.title,
    status: t.status,
  }));
}

export async function geneToPathways(geneSymbol: string): Promise<Array<{ pathway_id: string; name: string; source: string }>> {
  try {
    const conn = connectionManager.getConnection('reactome');
    
    const response = await conn.request(
      `/search/query?query=${encodeURIComponent(geneSymbol)}&species=Homo sapiens&limit=20&types=Pathway`
    ) as ReactomeSearchResponse;
    
    const pathways: Array<{ pathway_id: string; name: string; source: string }> = [];
    
    for (const group of (response.results || [])) {
      const entries = (group as Record<string, unknown>).entries as Array<Record<string, unknown>> | undefined;
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.type === 'Pathway' && entry.stId && entry.name) {
          const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
          pathways.push({
            pathway_id: entry.stId as string,
            name: name.replace(/<[^>]+>/g, ''),
            source: 'reactome',
          });
        }
      }
    }
    
    return pathways.slice(0, 20);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[geneToPathways] Error:', error);
    return [{ _error: `Pathway lookup for gene failed (source: reactome): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

export async function geneToArticles(geneSymbol: string): Promise<Article[]> {
  return await articleSearch(geneSymbol, { limit: 10 });
}

/**
 * Convert HGVS three-letter amino acid notation to single-letter shorthand.
 * e.g. "Val600Glu" -> "V600E", "Leu858Arg" -> "L858R"
 */
function hgvsToShorthand(hgvs: string): string {
  const THREE_TO_ONE: Record<string, string> = {
    Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C',
    Gln: 'Q', Glu: 'E', Gly: 'G', His: 'H', Ile: 'I',
    Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P',
    Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
    Ter: '*', // stop codon
  };
  // Handles simple missense substitutions only (e.g. Val600Glu -> V600E).
  // Complex HGVS patterns (del, ins, fs, dup, multi-position) pass through unchanged.
  // Match pattern like Val600Glu, Leu858Arg, etc.
  return hgvs.replace(
    /^([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})$/,
    (_, ref: string, pos: string, alt: string) => {
      const refLetter = THREE_TO_ONE[ref] || ref;
      const altLetter = THREE_TO_ONE[alt] || alt;
      return `${refLetter}${pos}${altLetter}`;
    }
  );
}

export async function variantToTrials(variantId: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  let searchQuery = variantId;
  let geneOnly = variantId;

  // Try variantGet first for rich gene/protein data, then fall back to variantSearch
  try {
    const { variantGet } = await import('./variant.js');
    const variant = await variantGet(variantId);
    if (variant.gene) {
      geneOnly = variant.gene;
      if (variant.hgvs_p) {
        const proteinChange = variant.hgvs_p.replace(/^p\./, '');
        const shorthand = hgvsToShorthand(proteinChange);
        searchQuery = `${variant.gene} ${shorthand}`;
      } else {
        searchQuery = variant.gene;
      }
    }
  } catch {
    try {
      const results = await variantSearch({ query: variantId, limit: 1 });
      if (results.length > 0 && results[0].gene) {
        geneOnly = results[0].gene;
        if (results[0].hgvs_p) {
          const proteinChange = results[0].hgvs_p.replace(/^p\./, '');
          const shorthand = hgvsToShorthand(proteinChange);
          searchQuery = `${results[0].gene} ${shorthand}`;
        } else {
          searchQuery = results[0].gene;
        }
      }
    } catch {
      // Use the raw variantId as last resort
    }
  }

  let response = await trialSearch(searchQuery, { limit: 10 });

  // Fallback: if gene+mutation search returns no results, try gene name only
  if (response.studies.length === 0 && geneOnly !== searchQuery) {
    response = await trialSearch(geneOnly, { limit: 10 });
  }

  return response.studies.map(t => ({
    nct_id: t.nct_id,
    title: t.title,
    status: t.status,
  }));
}

export async function drugToGenes(drugName: string): Promise<Array<{ gene_symbol: string; name: string; source: string; action_type?: string }>> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    
    const searchQuery = `query($name: String!) {
      search(queryString: $name, entityNames: ["drug"], page: {index: 0, size: 1}) {
        hits { id name }
      }
    }`;
    
    const searchRaw = await conn.request(searchQuery, { name: drugName }, { rootField: 'search' }) as any;
    const searchData = JSON.parse(JSON.stringify(searchRaw));
    const chemblId = searchData?.data?.search?.hits?.[0]?.id;
    
    if (!chemblId) {
      return [{ _error: `No OpenTargets entry found for drug '${drugName}'. Try drug_search to find valid drug names.` } as any];
    }
    
    const drugQuery = `query($chemblId: String!) {
      drug(chemblId: $chemblId) {
        id name
        mechanismsOfAction {
          rows { actionType targets { id approvedSymbol } }
        }
      }
    }`;
    
    const drugRaw = await conn.request(drugQuery, { chemblId }, { rootField: 'drug' }) as any;
    const drugData = JSON.parse(JSON.stringify(drugRaw));
    const rows = drugData?.data?.drug?.mechanismsOfAction?.rows || [];
    
    const seen = new Set<string>();
    const results: Array<{ gene_symbol: string; name: string; action_type?: string; source: string }> = [];
    for (const row of rows) {
      for (const t of row.targets || []) {
        if (t.approvedSymbol && !seen.has(t.approvedSymbol)) {
          seen.add(t.approvedSymbol);
          results.push({
            gene_symbol: t.approvedSymbol,
            name: t.approvedSymbol,
            action_type: row.actionType || undefined,
            source: 'opentargets',
          });
        }
      }
    }
    return results.slice(0, 20);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Gene target lookup for drug failed (source: opentargets): ${msg}. Try drug_search to find valid drug names, or try again later.` } as any];
  }
}

export async function drugToTrials(drugName: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  const response = await trialSearch(drugName, { limit: 10, searchType: 'intervention' });
  return response.studies.map(t => ({
    nct_id: t.nct_id,
    title: t.title,
    status: t.status,
  }));
}

export async function drugToAdverseEvents(drugName: string, limit = 20): Promise<AdverseEventsResult | Array<{ _error: string }>> {
  return fetchAdverseEvents(drugName, limit);
}

export async function diseaseToDrugs(diseaseQuery: string): Promise<Array<{ drug_name: string; source: string; phase?: string; report_count?: number }>> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    
    let searchTerm = diseaseQuery;
    
    if (diseaseQuery.match(/^(DOID|MONDO|OMIM|OMOPS|ORPHA):/i)) {
      try {
        const mydiseaseConn = connectionManager.getConnection('mydisease');
        const resolveResponse = await mydiseaseConn.request(
          `/disease/${encodeURIComponent(diseaseQuery)}`
        ) as any;
        
        if (resolveResponse) {
          const mondo = resolveResponse.mondo || {};
          const doData = resolveResponse.disease_ontology || {};
          searchTerm = mondo.label || doData.name || diseaseQuery;
        }
      } catch {
        searchTerm = diseaseQuery.replace(/^(DOID|MONDO):\d+$/, '');
      }
    }
    
    const searchQuery = `query($name: String!) {
      search(queryString: $name, entityNames: ["disease"], page: {index: 0, size: 1}) {
        hits { id name entity }
      }
    }`;
    
    const searchRaw = await conn.request(searchQuery, { name: searchTerm }, { rootField: 'search' }) as any;
    const searchData = JSON.parse(JSON.stringify(searchRaw));
    let diseaseId = searchData?.data?.search?.hits?.[0]?.id;

    if (!diseaseId && diseaseQuery.match(/^MONDO:/i)) {
      const efoId = diseaseQuery.replace(':', '_');
      const efoProbe = `query($efoId: String!) {
        disease(efoId: $efoId) { id name }
      }`;
      const efoRaw = await conn.request(efoProbe, { efoId }, { rootField: 'disease' }) as any;
      const efoData = JSON.parse(JSON.stringify(efoRaw));
      if (efoData?.data?.disease?.id) {
        diseaseId = efoData.data.disease.id;
      }
    }
    
    if (!diseaseId) {
      return [{ _error: `No OpenTargets entry found for disease '${diseaseQuery}'. Try disease_search first to verify the disease name or ID.` } as any];
    }
    
    const drugQuery = `query($efoId: String!) {
      disease(efoId: $efoId) {
        id name
        drugAndClinicalCandidates {
          rows { maxClinicalStage clinicalReports { id } drug { id name drugType } }
        }
      }
    }`;

    const drugRaw = await conn.request(drugQuery, { efoId: diseaseId }, { rootField: 'disease' }) as any;
    const drugData = JSON.parse(JSON.stringify(drugRaw));
    const rows: OtDrugCandidateRow[] = drugData?.data?.disease?.drugAndClinicalCandidates?.rows || [];

    return rankOtDrugRows(rows).slice(0, 20).map((r) => ({
      drug_name: r.drug?.name || '',
      source: 'opentargets',
      phase: r.maxClinicalStage || undefined,
      report_count: (r.clinicalReports || []).length,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Drug lookup for disease failed (source: opentargets): ${msg}. Try disease_search first to verify the disease name, or try again later.` } as any];
  }
}

export async function diseaseToGenes(diseaseId: string): Promise<Array<{ gene_symbol: string; name: string; source: string; score?: number }>> {
  try {
    const rows = await fetchDisgenetGdaSummary({ disease: diseaseId });

    return rows.slice(0, 20).map(r => ({
      gene_symbol: r.gene_symbol || '',
      name: r.gene_symbol || '',
      source: 'disgenet',
      score: r.score,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[diseaseToGenes] Error:', error);
    return [{ _error: `Gene association lookup for disease failed (source: disgenet): ${msg}. Try disease_search first to verify the disease ID, or try again later.` } as any];
  }
}

export async function diseaseToTrials(diseaseQuery: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  const response = await trialSearch(diseaseQuery, { limit: 10 });
  return response.studies.map(t => ({
    nct_id: t.nct_id,
    title: t.title,
    status: t.status,
  }));
}

export interface PathwayEnrichmentResult {
  pathway_id: string;
  name: string;
  p_value?: number;
  genes_overlap?: number;
  genes_total?: number;
  source: string;
}

export async function geneEnrichment(geneSymbols: string[]): Promise<PathwayEnrichmentResult[]> {
  if (!geneSymbols.length || geneSymbols.length < 3) {
    throw new Error('Gene enrichment requires at least 3 genes');
  }
  
  try {
    // Registry 'reactome_analysis' connection supplies rate limiting, timeout
    // and retry. The AnalysisService takes a plain-text identifier list, not JSON.
    const conn = connectionManager.getConnection('reactome_analysis') as RestConnection;
    const data = await conn.post('/identifiers/projection', geneSymbols.join('\n')) as ReactomeAnalysisResponse;
    const pathways = data?.pathways || [];
    
    return pathways.slice(0, 30).map((p: { stId?: string; name?: string; entities?: { pValue?: number; found?: number; total?: number } }) => ({
      pathway_id: p.stId || '',
      name: p.name || '',
      p_value: p.entities?.pValue,
      genes_overlap: p.entities?.found,
      genes_total: p.entities?.total,
      source: 'reactome',
    }));
  } catch (error) {
    // Cause-aware message: raw fetch rejections hide their errno code
    // (ETIMEDOUT, ECONNREFUSED, ...) in error.cause — surface it (see
    // src/entities/errors.ts) before classifying the failure.
    const msg = errorMessageWithCause(error);
    if (msg.includes('abort') || msg.includes('timeout')) {
      return [{ _error: `Gene enrichment analysis failed (source: reactome): Request timed out after 15s. The Reactome AnalysisService may be temporarily unavailable. Try again later.` } as any];
    }
    // Network-level failure (issue #62): transport errors reaching this
    // catch are connectivity problems, not bad gene input — never blame the
    // user's symbols. Detected via cause code or a network message signature.
    if (networkCauseCode(error) || /fetch failed|network|ECONN|ETIMEDOUT/i.test(msg)) {
      return [{ _error: `Gene enrichment analysis failed (source: reactome): ${msg}. Network error reaching reactome.org — the service was not the problem; check connectivity (biomcp honors HTTPS_PROXY/HTTP_PROXY/NO_PROXY if you route through a proxy) and try again.` } as any];
    }
    return [{ _error: `Gene enrichment analysis failed (source: reactome): ${msg}. Ensure at least 3 valid gene symbols are provided, or try again later.` } as any];
  }
}

export interface DiscoverResult {
  entity_type: string;
  identifier: string;
  name: string;
  /** Why this record was selected: 'exact' or 'first' (see DiscoverMatchRule). */
  matched_on?: DiscoverMatchRule;
  source?: string;
  description?: string;
  matches?: Array<{ type: string; id: string; name: string; score: number }>;
}

/**
 * Why a discover record was selected from its backend's candidates:
 * - 'exact': the record's symbol/name/label equals the query verbatim
 *   (case-insensitive, whitespace-trimmed).
 * - 'first': no exact match existed, so the backend's first candidate with a
 *   non-empty name or identifier was used (the pre-ranking default).
 */
export type DiscoverMatchRule = 'exact' | 'first';

/** How many candidates discover asks each backend for (best-of-N selection). */
const DISCOVER_CANDIDATE_LIMIT = 5;

/** Name-ish fields of a candidate compared against the query, plus its identifier. */
interface CandidateAccessors<T> {
  nameFields: (candidate: T) => Array<string | undefined>;
  identifier: (candidate: T) => string | undefined;
}

function normalizeForMatch(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

/**
 * Pick the best candidate for a free-text query from a backend's hit list.
 * - 'exact': the first candidate whose name/symbol/label equals the query
 *   (case-insensitive, whitespace-trimmed) wins, even when substring matches
 *   rank higher in the backend's default order.
 * - 'first': the backend's first candidate with a non-empty name OR identifier
 *   (candidates empty on BOTH fields are skipped — discover never emits
 *   empty records).
 * Returns null when every candidate is empty (or the list is empty).
 */
function pickBestMatch<T>(
  query: string,
  candidates: T[],
  accessors: CandidateAccessors<T>
): { candidate: T; rule: DiscoverMatchRule } | null {
  const wanted = normalizeForMatch(query);
  let fallback: { candidate: T; rule: DiscoverMatchRule } | null = null;

  for (const candidate of candidates.slice(0, DISCOVER_CANDIDATE_LIMIT)) {
    const identifier = accessors.identifier(candidate) || '';
    const names = accessors.nameFields(candidate).map(n => n || '');
    if (names.every(n => n.trim() === '') && identifier.trim() === '') {
      continue; // neither a name nor an identifier — not emittable
    }
    if (!fallback) {
      fallback = { candidate, rule: 'first' };
    }
    if (wanted !== '' && names.some(n => normalizeForMatch(n) === wanted)) {
      return { candidate, rule: 'exact' };
    }
  }

  return fallback;
}

export async function discover(query: string): Promise<DiscoverResult[]> {
  const results: DiscoverResult[] = [];

  const [geneResults, variantResults, drugResults, diseaseResults] = await Promise.allSettled([
    geneSearch(query, { limit: DISCOVER_CANDIDATE_LIMIT }),
    variantSearch({ query, limit: DISCOVER_CANDIDATE_LIMIT }),
    drugSearch(query, { limit: DISCOVER_CANDIDATE_LIMIT }),
    diseaseSearch(query, { limit: DISCOVER_CANDIDATE_LIMIT }),
  ]);

  if (geneResults.status === 'fulfilled') {
    const pick = pickBestMatch(query, geneResults.value, {
      nameFields: (c: GeneSearchResult) => [c.symbol, c.name],
      identifier: (c: GeneSearchResult) => c.symbol,
    });
    if (pick) {
      results.push({
        entity_type: 'gene',
        identifier: pick.candidate.symbol,
        name: pick.candidate.name,
        source: 'mygene',
        matched_on: pick.rule,
      });
    }
  }

  if (variantResults.status === 'fulfilled') {
    const pick = pickBestMatch(query, variantResults.value, {
      nameFields: (c: VariantSearchResult) => [c.id],
      identifier: (c: VariantSearchResult) => c.id,
    });
    if (pick) {
      results.push({
        entity_type: 'variant',
        identifier: pick.candidate.id,
        name: pick.candidate.id,
        source: 'myvariant',
        matched_on: pick.rule,
      });
    }
  }

  if (drugResults.status === 'fulfilled') {
    const pick = pickBestMatch(query, drugResults.value, {
      nameFields: (c: DrugSearchResult) => [c.name],
      identifier: (c: DrugSearchResult) => c.name,
    });
    if (pick) {
      results.push({
        entity_type: 'drug',
        identifier: pick.candidate.name,
        name: pick.candidate.name,
        source: 'mychem',
        matched_on: pick.rule,
      });
    }
  }

  if (diseaseResults.status === 'fulfilled') {
    const pick = pickBestMatch(query, diseaseResults.value, {
      nameFields: (c: DiseaseSearchResult) => [c.name],
      identifier: (c: DiseaseSearchResult) => c.disease_id,
    });
    if (pick) {
      results.push({
        entity_type: 'disease',
        identifier: pick.candidate.disease_id,
        name: pick.candidate.name,
        source: 'mydisease',
        matched_on: pick.rule,
      });
    }
  }

  if (results.length === 0) {
    try {
      const conn = connectionManager.getConnection('ols4');
      const response = await conn.request(
        `/api/search?q=${encodeURIComponent(query)}&size=3`
      ) as OLSResponse;

      if (response.response?.docs?.length) {
        const wanted = normalizeForMatch(query);
        for (const doc of response.response.docs) {
          results.push({
            entity_type: doc.type || 'unknown',
            identifier: doc.iri || doc.obo_id || '',
            name: doc.label || query,
            source: doc.ontology_name || 'ols',
            matched_on: wanted !== '' && normalizeForMatch(doc.label) === wanted ? 'exact' : 'first',
          });
        }
      }
    } catch (error) {
      console.error('[discover/ols4] Error:', error);
    }
  }

  return results;
}

export interface SearchAllResult {
  entity_type: string;
  results: unknown[];
}

export async function searchAll(
  query: string,
  options?: { limit?: number; entities?: string[] }
): Promise<SearchAllResult[]> {
  const limit = options?.limit || 5;
  const entities = options?.entities || ['gene', 'variant', 'drug', 'disease', 'article', 'trial'];
  
  const searches: Array<{ entity: string; promise: Promise<unknown> }> = [];
  
  if (entities.includes('gene')) {
    searches.push({ entity: 'gene', promise: geneSearch(query, { limit }) });
  }
  if (entities.includes('variant')) {
    searches.push({ entity: 'variant', promise: variantSearch({ query, limit }) });
  }
  if (entities.includes('drug')) {
    searches.push({ entity: 'drug', promise: drugSearch(query, { limit }) });
  }
  if (entities.includes('disease')) {
    searches.push({ entity: 'disease', promise: diseaseSearch(query, { limit }) });
  }
  if (entities.includes('article')) {
    searches.push({ entity: 'article', promise: articleSearch(query, { limit }) });
  }
  if (entities.includes('trial')) {
    searches.push({ entity: 'trial', promise: trialSearch(query, { limit }).then(r => r.studies) });
  }
  
  const results = await Promise.allSettled(searches.map(s => s.promise));
  
  const searchAllResults: SearchAllResult[] = [];
  
  for (let i = 0; i < results.length; i++) {
    const settled = results[i];
    if (settled.status === 'fulfilled') {
      searchAllResults.push({
        entity_type: searches[i].entity,
        results: settled.value as unknown[],
      });
    } else {
      searchAllResults.push({
        entity_type: searches[i].entity,
        results: [{ _error: `${searches[i].entity} search failed: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}. This may be a temporary data source issue. Try again or search individually.` }],
      });
    }
  }
  
  return searchAllResults;
}

export interface BatchGetInput {
  entity: string;
  id: string;
  sections?: string[];
}

export interface BatchGetResult {
  entity: string;
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export async function batchGet(inputs: BatchGetInput[]): Promise<BatchGetResult[]> {
  const results: BatchGetResult[] = [];
  
  const promises = inputs.map(async (input): Promise<BatchGetResult> => {
    try {
      let data: unknown;
      
      switch (input.entity) {
        case 'gene': {
          const { geneGet } = await import('./gene.js');
          data = await geneGet(input.id, input.sections);
          break;
        }
        case 'variant': {
          const { variantGet } = await import('./variant.js');
          data = await variantGet(input.id, input.sections);
          break;
        }
        case 'drug': {
          const { drugGet } = await import('./drug.js');
          data = await drugGet(input.id, input.sections);
          break;
        }
        case 'disease': {
          const { diseaseGet } = await import('./disease.js');
          data = await diseaseGet(input.id, input.sections);
          break;
        }
        case 'trial': {
          const { trialGet } = await import('./trial.js');
          data = await trialGet(input.id, input.sections);
          break;
        }
        case 'article': {
          const { articleGet } = await import('./article/index.js');
          // Batch fulltext is file-only: each article returns a small
          // handle (path + outline), never body text. Inline fulltext is
          // available via article_get with fulltext_output="inline".
          data = await articleGet(input.id, input.sections, { fulltextOutput: 'file' });
          break;
        }
        case 'patent': {
          const { patentGet } = await import('./patent/index.js');
          data = await patentGet(input.id, input.sections);
          break;
        }
        default:
          throw new Error(`Unknown entity: ${input.entity}`);
      }
      
      return { entity: input.entity, id: input.id, success: true, data };
    } catch (error) {
      return {
        entity: input.entity,
        id: input.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  
  const settled = await Promise.allSettled(promises);
  
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      results.push(s.value);
    } else {
      results.push({
        entity: 'unknown',
        id: 'unknown',
        success: false,
        error: s.reason?.message || 'Unknown error',
      });
    }
  }
  
  return results;
}

interface DGIdbGeneResponse {
  data?: {
    drugs?: Array<{ drug: string; sources: string[] }>;
  };
}

interface ReactomeSearchResponse {
  results?: Array<Record<string, unknown>>;
}

interface ReactomeAnalysisResponse {
  pathways?: Array<{
    stId: string;
    name: string;
    entities: {
      pValue?: number;
      found?: number;
      total?: number;
    };
  }>;
}

interface ChemblMechanismResponse {
  mechanisms?: Array<{
    molecule_name?: string;
    disease_name?: string;
    trial_phase?: string;
  }>;
}

interface OLSResponse {
  response?: {
    docs?: Array<{
      iri?: string;
      obo_id?: string;
      label?: string;
      type?: string;
      ontology_name?: string;
      description?: string[];
    }>;
    numFound?: number;
  };
}
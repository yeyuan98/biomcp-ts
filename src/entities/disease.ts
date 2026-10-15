import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';
import { fetchDisgenetGdaSummary } from './disgenet.js';
import { otGenesForDisease } from './opentargets.js';

const SECTION_TIMEOUT_MS = 8000;

export interface DiseaseSearchOptions {
  limit?: number;
  offset?: number;
}

export interface DiseaseSearchResult {
  name: string;
  disease_id: string;
  mondo_id?: string;
  doid?: string;
}

export interface DiseaseGetOptions {
  sections?: string[];
}

export interface DiseaseResult {
  name: string;
  disease_id: string;
  description?: string;
  ontology?: string;
  sections?: Record<string, unknown>;
}

export async function diseaseSearch(
  query: string,
  options: DiseaseSearchOptions = {}
): Promise<DiseaseSearchResult[]> {
  const { limit = 10, offset = 0 } = options;

  const conn = connectionManager.getConnection('mydisease');

  const queryParams = new URLSearchParams({
    q: query,
    fields: 'mondo.label,mondo.id,disease_ontology.name,disease_ontology.doid',
    size: String(limit),
    from: String(offset),
  });

  const response = await conn.request(`/query?${queryParams.toString()}`) as MyDiseaseSearchResponse;
  
  const hits = (response.hits || []).map(transformMyDiseaseHit);
  
  return hits.sort((a, b) => {
    const aIsAnimal = /^MONDO:1010/.test(a.disease_id) ? 1 : 0;
    const bIsAnimal = /^MONDO:1010/.test(b.disease_id) ? 1 : 0;
    return aIsAnimal - bIsAnimal;
  });
}

/** Alternate curie separator form: MONDO_0007254 ↔ MONDO:0007254. */
function altCurieForm(id: string): string | undefined {
  let match = /^([A-Za-z]{2,8})_(\d+)$/.exec(id);
  if (match) return `${match[1]}:${match[2]}`;
  match = /^([A-Za-z]{2,8}):(\d+)$/.exec(id);
  if (match) return `${match[1]}_${match[2]}`;
  return undefined;
}

/** UMLS Concept Unique Identifier, e.g. C0018794 / C0006142. */
const UMLS_CUI_PATTERN = /^C\d{6,7}$/i;

/**
 * Resolve a UMLS CUI to the document id mydisease keys records by. The
 * `/disease/{cui}` endpoint 404s for CUIs (mydisease keys documents by
 * MONDO/DOID/HP ids), but the query endpoint resolves them — note the field
 * path is exactly `umls.umls` (top-level `umls` is an object; plain
 * `umls:"C..."` and `mondo.xrefs.umls_cui` both return 0 hits, live-verified:
 * C0018794 → HP:0012722, C0006142 → MONDO:0007254).
 */
async function resolveUmlsCui(cui: string, conn: { request: (path: string) => Promise<unknown> }): Promise<string | null> {
  const queryParams = new URLSearchParams({
    q: `umls.umls:"${cui}"`,
    fields: '_id',
    size: '1',
  });
  const response = await conn.request(`/query?${queryParams.toString()}`) as { hits?: Array<{ _id?: string }> };
  return response.hits?.[0]?._id ?? null;
}

export async function diseaseGet(
  diseaseId: string,
  sections?: string[]
): Promise<DiseaseResult> {
  const sectionConfig = sections || ['core'];

  const conn = connectionManager.getConnection('mydisease');

  let disease: MyDiseaseRecord | null = null;

  // UMLS CUI input (e.g. "C0018794" — the disease_get docstring's own
  // example): mydisease's /disease/{id} endpoint 404s for CUIs, so resolve
  // the CUI to its document id via the query endpoint first. The `umls:{cui}`
  // curie form stays in the candidate list as a fallback because some CUIs
  // resolve to UMLS-sourced documents whose own id /disease/ will not serve
  // (live: C0018794 → HP:0012722 404s, while /disease/umls:C0018794 works).
  let lookupId = diseaseId;
  const cuiMatch = UMLS_CUI_PATTERN.exec(diseaseId.trim());
  if (cuiMatch) {
    const cui = cuiMatch[0].toUpperCase();
    try {
      lookupId = (await resolveUmlsCui(cui, conn)) ?? `umls:${cui}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[diseaseGet] UMLS CUI resolution for '${cui}' failed: ${msg}`);
      lookupId = `umls:${cui}`;
    }
  }

  // Primary /disease/{id} lookup, retrying the alternate curie separator
  // form (the API keys records as MONDO:0007254 but DisGeNET-style callers
  // often paste MONDO_0007254, and vice versa). A free-text `q=<id>` query
  // returns 0 hits for IDs, so it is not used as a fallback.
  const candidates = altCurieForm(lookupId) ? [lookupId, altCurieForm(lookupId)!] : [lookupId];
  if (cuiMatch) {
    const umlsCurie = `umls:${cuiMatch[0].toUpperCase()}`;
    if (!candidates.includes(umlsCurie)) candidates.push(umlsCurie);
  }
  for (const candidate of candidates) {
    try {
      const directResponse = await conn.request(`/disease/${encodeURIComponent(candidate)}`) as any;
      if (directResponse && directResponse._id) {
        const doData = directResponse.disease_ontology || {};
        const mondoData = directResponse.mondo || {};
        disease = {
          name: mondoData.label || doData.name || diseaseId,
          diseaseid: directResponse._id || diseaseId,
          description: doData.def || '',
          ontology: mondoData.label ? 'mondo' : 'disease_ontology',
        };
        break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[diseaseGet] Direct lookup for '${candidate}' failed: ${msg}`);
    }
  }

  if (!disease) {
    throw new Error(`Disease '${diseaseId}' not found. Try disease_search to find valid disease IDs. Supported ID formats: MONDO:XXXXXXX, DOID:XXXXXXX, OMIM:XXXXXX, UMLS CUI (e.g. C0018794).`);
  }
  const result: DiseaseResult = {
    name: disease.name,
    disease_id: disease.diseaseid,
    description: disease.description,
    ontology: disease.ontology,
  };
  
  const sectionsToFetch = sectionConfig.includes('all')
    ? ['gene_associations', 'phenotypes', 'pathways']
    : sectionConfig.filter(s => s !== 'core');

  if (sectionsToFetch.length > 0) {
    const sectionPromises = sectionsToFetch.map(section => {
      return fetchWithTimeout(async () => {
        switch (section) {
          case 'gene_associations': return { section: 'gene_associations', data: await fetchGeneAssociations(disease.diseaseid, disease.name) };
          case 'phenotypes': return { section: 'phenotypes', data: await fetchPhenotypes(disease.diseaseid) };
          case 'pathways': return { section: 'pathways', data: await fetchPathways(disease.diseaseid) };
          default: return { section, data: null };
        }
      }, SECTION_TIMEOUT_MS);
    });

    const settledResults = await Promise.allSettled(sectionPromises);
    
    result.sections = {};
    for (let si = 0; si < settledResults.length; si++) {
      const settled = settledResults[si];
      if (settled.status === 'fulfilled' && settled.value.data) {
        const sectionData = settled.value.data as { section: string; data: unknown };
        (result.sections as Record<string, unknown>)[sectionData.section] = sectionData.data;
      } else if (settled.status === 'fulfilled' && settled.value.error) {
        const sectionResult = settled.value as { error?: string };
        (result.sections as Record<string, unknown>)[sectionsToFetch[si]] = {
          _error: sectionResult.error
        };
      } else if (settled.status === 'rejected') {
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        (result.sections as Record<string, unknown>)[sectionsToFetch[si]] = {
          _error: `Section '${sectionsToFetch[si]}' fetch failed: ${reason}. The data source may be temporarily unavailable.`
        };
      }
    }
  }
  
  return result;
}

/**
 * Gene associations for a disease with a keyless OpenTargets fallback
 * (issue #84): DisGeNET when an API key is configured, else — or when the
 * DisGeNET leg fails — OpenTargets' reverse `associatedTargets` association.
 * When BOTH legs fail the error row names both reasons instead of silently
 * dropping the OpenTargets failure.
 */
async function fetchGeneAssociations(
  diseaseId: string,
  diseaseName?: string
): Promise<Array<{ gene_symbol: string; name: string; disease_name?: string; score?: number; pmids?: number; source: string }>> {
  let disgenetReason: string | undefined =
    'DISGENET_API_KEY environment variable is not set. DisGeNET requires an API key for gene-disease associations. Obtain one at https://www.disgenet.org/ and set it in your environment.';

  if (process.env.DISGENET_API_KEY) {
    try {
      const rows = await fetchDisgenetGdaSummary({ disease: diseaseId });

      return rows.slice(0, 20).map(r => ({
        gene_symbol: r.gene_symbol || '',
        name: r.gene_symbol || '',
        disease_name: r.disease_name,
        score: r.score,
        pmids: r.pmids,
        source: 'disgenet',
      }));
    } catch (error) {
      disgenetReason = error instanceof Error ? error.message : String(error);
      // Fall through to the OpenTargets leg, keeping the failure reason.
    }
  }

  try {
    return (await otGenesForDisease(diseaseId, diseaseName)).slice(0, 20);
  } catch (otError) {
    const otMsg = otError instanceof Error ? otError.message : String(otError);
    return [{
      _error: `Gene association lookup failed: DisGeNET unavailable (${disgenetReason}); OpenTargets fallback also failed (${otMsg}). The data source may be temporarily unavailable.`,
    } as any];
  }
}

async function fetchPhenotypes(diseaseId: string): Promise<Array<{ hpo_id: string; name: string }> | { _error: string }> {
  try {
    const conn = connectionManager.getConnection('monarch');

    const params = new URLSearchParams({
      subject: diseaseId,
      object_category: 'biolink:PhenotypicFeature',
      limit: '20',
    });

    const response = await conn.request(
      `/v3/api/association?${params.toString()}`
    ) as any;

    if (response?.items && Array.isArray(response.items)) {
      return response.items
        .filter((item: any) => item.object?.startsWith('HP:'))
        .map((item: any) => ({
          hpo_id: item.object,
          name: item.object_label || '',
        }));
    }

    return [];
  } catch {
    return { _error: 'Phenotype lookup failed (source: monarch). The Monarch Initiative API is currently unavailable. Try again later, or visit https://hpo.jax.org/app/browse/disease/DOID:1612 for manual lookup.' };
  }
}

async function fetchPathways(diseaseId: string): Promise<Array<{ pathway_id: string; name: string; source: string }>> {
  try {
    const conn = connectionManager.getConnection('reactome');
    
    const response = await conn.request(
      `/search/query?query=${encodeURIComponent(diseaseId)}&limit=10`
    ) as ReactomeDiseaseResponse;
    
    return (response.results || []).slice(0, 20).map(r => ({
      pathway_id: r.stId,
      name: r.name,
      source: 'reactome',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Pathway lookup failed (source: reactome): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

interface MyDiseaseSearchResponse {
  hits: Array<Record<string, unknown>>;
}

interface MyDiseaseRecord {
  name: string;
  diseaseid: string;
  description?: string;
  ontology?: string;
}

interface MonarchPhenotypesResponse {
  results: Array<{
    hpo_id: string;
    name: string;
  }>;
}

interface ReactomeDiseaseResponse {
  results: Array<{
    stId: string;
    name: string;
  }>;
}

export function transformMyDiseaseHit(hit: Record<string, unknown>): DiseaseSearchResult {
  const mondo = hit.mondo as Record<string, unknown> | undefined;
  const diseaseOntology = hit.disease_ontology as Record<string, unknown> | undefined;
  
  return {
    name: (mondo?.label || diseaseOntology?.name || '') as string,
    disease_id: (hit._id as string) || '',
    mondo_id: (mondo?.id as string) || undefined,
    doid: (diseaseOntology?.doid as string) || undefined,
  };
}

export function transformMyDiseaseResponse(data: Record<string, unknown>): DiseaseResult {
  const mondo = data.mondo as Record<string, unknown> | undefined;
  const diseaseOntology = data.disease_ontology as Record<string, unknown> | undefined;
  
  return {
    name: (mondo?.label || diseaseOntology?.name || '') as string,
    disease_id: (data._id as string) || '',
    description: (diseaseOntology?.def as string) || '',
    ontology: mondo ? 'mondo' : diseaseOntology ? 'disease_ontology' : undefined,
  };
}
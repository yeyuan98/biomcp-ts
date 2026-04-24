import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';

const SECTION_TIMEOUT_MS = 8000;

export interface DiseaseSearchOptions {
  disease_type?: string;
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
  const { disease_type, limit = 10, offset = 0 } = options;
  
  const conn = connectionManager.getConnection('mydisease');
  
  const queryParams = new URLSearchParams({
    q: query,
    fields: 'mondo.label,mondo.id,disease_ontology.name,disease_ontology.doid',
    size: String(limit),
    from: String(offset),
  });
  
  if (disease_type) {
    queryParams.set('type', disease_type);
  }
  
  const response = await conn.request(`/query?${queryParams.toString()}`) as MyDiseaseSearchResponse;
  
  const hits = (response.hits || []).map(transformMyDiseaseHit);
  
  return hits.sort((a, b) => {
    const aIsAnimal = /^MONDO:1010/.test(a.disease_id) ? 1 : 0;
    const bIsAnimal = /^MONDO:1010/.test(b.disease_id) ? 1 : 0;
    return aIsAnimal - bIsAnimal;
  });
}

export async function diseaseGet(
  diseaseId: string,
  sections?: string[]
): Promise<DiseaseResult> {
  const sectionConfig = sections || ['core'];
  
  const conn = connectionManager.getConnection('mydisease');
  
  let disease: MyDiseaseRecord | null = null;
  
  try {
    const directResponse = await conn.request(`/disease/${encodeURIComponent(diseaseId)}`) as any;
    if (directResponse && directResponse._id) {
      const doData = directResponse.disease_ontology || {};
      const mondoData = directResponse.mondo || {};
      disease = {
        name: mondoData.label || doData.name || diseaseId,
        diseaseid: directResponse._id || diseaseId,
        description: doData.def || '',
        ontology: mondoData.label ? 'mondo' : 'disease_ontology',
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[diseaseGet] Direct lookup for '${diseaseId}' failed: ${msg}`);
  }
  
  if (!disease) {
    const queryParams = new URLSearchParams({
      q: diseaseId,
      fields: 'mondo.label,mondo.id,disease_ontology.name,disease_ontology.doid,disease_ontology.def',
      size: '1',
    });
    
    const response = await conn.request(`/query?${queryParams.toString()}`) as MyDiseaseGetResponse;
    
    if (!response.hits || response.hits.length === 0) {
      throw new Error(`Disease '${diseaseId}' not found. Try disease_search to find valid disease IDs. Supported ID formats: MONDO:XXXXXXX, DOID:XXXXXXX, OMIM:XXXXXX.`);
    }
    
    const hit = response.hits[0];
    const hitMondo = hit.mondo as Record<string, unknown> | undefined;
    const hitDo = hit.disease_ontology as Record<string, unknown> | undefined;
    disease = {
      name: (hitMondo?.label || hitDo?.name || diseaseId) as string,
      diseaseid: (hit._id as string) || diseaseId,
      description: (hitDo?.def as string) || '',
      ontology: hitMondo ? 'mondo' : hitDo ? 'disease_ontology' : undefined,
    };
  }
  const result: DiseaseResult = {
    name: disease.name,
    disease_id: disease.diseaseid,
    description: disease.description,
    ontology: disease.ontology,
  };
  
  const sectionsToFetch = sectionConfig.includes('all') 
    ? ['gene_associations', 'phenotypes', 'pathways', 'survival']
    : sectionConfig.filter(s => s !== 'core');

  if (sectionsToFetch.length > 0) {
    const sectionPromises = sectionsToFetch.map(section => {
      return fetchWithTimeout(async () => {
        switch (section) {
          case 'gene_associations': return { section: 'gene_associations', data: await fetchGeneAssociations(disease.diseaseid) };
          case 'phenotypes': return { section: 'phenotypes', data: await fetchPhenotypes(disease.diseaseid) };
          case 'pathways': return { section: 'pathways', data: await fetchPathways(disease.diseaseid) };
          case 'survival': return { section: 'survival', data: await fetchSurvival(disease.diseaseid) };
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
          error: sectionResult.error 
        };
      } else if (settled.status === 'rejected') {
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        (result.sections as Record<string, unknown>)[sectionsToFetch[si]] = {
          error: `Section '${sectionsToFetch[si]}' fetch failed: ${reason}. The data source may be temporarily unavailable.`
        };
      }
    }
  }
  
  return result;
}

async function fetchGeneAssociations(diseaseId: string): Promise<Array<{ gene_symbol: string; name: string; score: number; source: string }>> {
  try {
    if (!process.env.DISGENET_API_KEY) {
      return [{ _error: `Gene association lookup failed (source: disgenet): DISGENET_API_KEY environment variable is not set. DisGeNET requires an API key for gene-disease associations. Obtain one at https://www.disgenet.org/ and set it in your environment.` } as any];
    }

    const conn = connectionManager.getConnection('disgenet');
    
    const response = await conn.request(
      `/api/v1/disease/${encodeURIComponent(diseaseId)}?format=json`
    ) as DisgenetDiseaseResponse;
    
    return (response.results || []).slice(0, 20).map(r => ({
      gene_symbol: r.geneSymbol,
      name: r.geneName,
      score: r.score,
      source: r.geneDatasource,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Gene association lookup failed (source: disgenet): ${msg}. The data source may be temporarily unavailable.` } as any];
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

async function fetchSurvival(diseaseId: string): Promise<{ median_overall?: number; median_progression?: number }> {
  try {
    const conn = connectionManager.getConnection('seer');
    
    const response = await conn.request(
      `/disease/${encodeURIComponent(diseaseId)}?format=json`
    ) as SEERResponse;
    
    return {
      median_overall: response.median_overall,
      median_progression: response.median_progression,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { _error: `Survival data lookup failed (source: seer): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

interface MyDiseaseSearchResponse {
  hits: Array<Record<string, unknown>>;
}

interface MyDiseaseGetResponse {
  hits: Array<Record<string, unknown>>;
}

interface MyDiseaseRecord {
  name: string;
  diseaseid: string;
  description?: string;
  ontology?: string;
}

interface DisgenetDiseaseResponse {
  results: Array<{
    geneSymbol: string;
    geneName: string;
    score: number;
    geneDatasource: string;
  }>;
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

interface SEERResponse {
  median_overall?: number;
  median_progression?: number;
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
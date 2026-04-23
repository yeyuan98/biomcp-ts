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
  ontology?: string;
  phenotype_ids?: string[];
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
    fields: 'name,diseaseid,ontology',
    size: String(limit),
    from: String(offset),
  });
  
  if (disease_type) {
    queryParams.set('type', disease_type);
  }
  
  const response = await conn.request(`/search?${queryParams.toString()}`) as MyDiseaseSearchResponse;
  
  return (response.hits || []).map(transformMyDiseaseHit);
}

export async function diseaseGet(
  diseaseId: string,
  sections?: string[]
): Promise<DiseaseResult> {
  const sectionConfig = sections || ['core'];
  
  const conn = connectionManager.getConnection('mydisease');
  
  const queryParams = new URLSearchParams({
    q: `diseaseid:"${diseaseId}" OR ${diseaseId}`,
    fields: 'name,diseaseid,description,ontology',
    size: '1',
  });
  
  const response = await conn.request(`/get?${queryParams.toString()}`) as MyDiseaseGetResponse;
  
  if (!response.hits || response.hits.length === 0) {
    throw new Error(`Disease '${diseaseId}' not found. Try disease_search to find valid disease IDs.`);
  }
  
  const disease = response.hits[0];
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
    for (const settled of settledResults) {
      if (settled.status === 'fulfilled' && settled.value.data) {
        const sectionData = settled.value.data as { section: string; data: unknown };
        (result.sections as Record<string, unknown>)[sectionData.section] = sectionData.data;
      } else if (settled.status === 'fulfilled' && settled.value.error) {
        const sectionResult = settled.value as { error?: string };
        (result.sections as Record<string, unknown>)[sectionsToFetch[settledResults.indexOf(settled)]] = { 
          error: sectionResult.error 
        };
      }
    }
  }
  
  return result;
}

async function fetchGeneAssociations(diseaseId: string): Promise<Array<{ gene_symbol: string; name: string; score: number; source: string }>> {
  try {
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
  } catch {
    return [];
  }
}

async function fetchPhenotypes(diseaseId: string): Promise<Array<{ hpo_id: string; name: string }>> {
  try {
    const conn = connectionManager.getConnection('monarch');
    
    const response = await conn.request(
      `/disease/${encodeURIComponent(diseaseId)}/phenotypes?format=json`
    ) as MonarchPhenotypesResponse;
    
    return (response.results || []).slice(0, 20).map(r => ({
      hpo_id: r.hpo_id,
      name: r.name,
    }));
  } catch {
    return [];
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
  } catch {
    return [];
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
  } catch {
    return {};
  }
}

interface MyDiseaseSearchResponse {
  hits: Array<{
    name: string;
    diseaseid: string;
    ontology?: string;
  }>;
}

interface MyDiseaseGetResponse {
  hits: Array<{
    name: string;
    diseaseid: string;
    description?: string;
    ontology?: string;
  }>;
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

export function transformMyDiseaseHit(hit: MyDiseaseSearchResponse['hits'][0]): DiseaseSearchResult {
  return {
    name: hit.name,
    disease_id: hit.diseaseid,
    ontology: hit.ontology,
  };
}

export function transformMyDiseaseResponse(data: MyDiseaseGetResponse['hits'][0]): DiseaseResult {
  return {
    name: data.name,
    disease_id: data.diseaseid,
    description: data.description,
    ontology: data.ontology,
  };
}
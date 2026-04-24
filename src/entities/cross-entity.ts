import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';
import { geneSearch, GeneSearchResult } from './gene.js';
import { variantSearch, VariantSearchResult } from './variant.js';
import { drugSearch, DrugSearchResult } from './drug.js';
import { diseaseSearch, DiseaseSearchResult } from './disease.js';
import { trialSearch, TrialSearchResult } from './trial.js';
import { articleSearch, Article } from './article.js';

const SECTION_TIMEOUT_MS = 8000;

export async function geneToDrugs(geneSymbol: string): Promise<Array<{ drug_name: string; source: string; action_type?: string }>> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    
    const searchQuery = `query($symbol: String!) {
      search(queryString: $symbol, entityNames: ["target"], page: {index: 0, size: 1}) {
        hits { id name entity }
      }
    }`;
    
    const searchRaw = await conn.request(searchQuery, { symbol: geneSymbol }) as any;
    const searchData = JSON.parse(JSON.stringify(searchRaw));
    const targetId = searchData?.data?.search?.hits?.[0]?.id;
    
    if (!targetId) {
      return [{ _error: `No OpenTargets entry found for gene '${geneSymbol}'. Verify the gene symbol using gene_search.` } as any];
    }
    
    const drugQuery = `query($ensemblId: String!) {
      target(ensemblId: $ensemblId) {
        drugAndClinicalCandidates {
          rows { maxClinicalStage drug { id name drugType } }
        }
      }
    }`;
    
    const drugRaw = await conn.request(drugQuery, { ensemblId: targetId }) as any;
    const drugData = JSON.parse(JSON.stringify(drugRaw));
    const rows = drugData?.data?.target?.drugAndClinicalCandidates?.rows || [];
    
    return rows.slice(0, 20).map((r: { maxClinicalStage?: string; drug?: { name?: string; drugType?: string } }) => ({
      drug_name: r.drug?.name || 'unknown',
      source: 'opentargets',
      action_type: r.drug?.drugType,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Drug lookup for gene failed (source: opentargets): ${msg}. Try gene_search first to verify the gene symbol, or try again later.` } as any];
  }
}

export async function geneToTrials(geneSymbol: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  const trials = await trialSearch(geneSymbol, { limit: 10 });
  return trials.map(t => ({
    nct_id: t.nct_id,
    title: t.title,
    status: t.status,
  }));
}

export async function geneToPathways(geneSymbol: string): Promise<Array<{ pathway_id: string; name: string; source: string }>> {
  try {
    const conn = connectionManager.getConnection('reactome');
    
    const response = await conn.request(
      `/search/query?query=${encodeURIComponent(geneSymbol)}&species=Homo sapiens&limit=20`
    ) as ReactomeSearchResponse;
    
    return (response.results || []).map(r => ({
      pathway_id: r.stId,
      name: r.name,
      source: 'reactome',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[geneToPathways] Error:', error);
    return [{ _error: `Pathway lookup for gene failed (source: reactome): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

export async function geneToArticles(geneSymbol: string): Promise<Article[]> {
  const articles = await articleSearch(geneSymbol, { limit: 10 });
  return articles;
}

export async function variantToTrials(variantId: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  const trials = await trialSearch(variantId, { limit: 10 });
  return trials.map(t => ({
    nct_id: t.nct_id,
    title: t.title,
    status: t.status,
  }));
}

export async function drugToGenes(drugName: string): Promise<Array<{ gene_symbol: string; name: string; source: string; action_type?: string }>> {
  try {
    const conn = connectionManager.getConnection('chembl');
    
    const response = await conn.request(
      `/target?molecule_synonym=${encodeURIComponent(drugName)}&format=json`
    ) as ChemblTargetResponse;
    
    return (response.targets || []).slice(0, 20).map(t => ({
      gene_symbol: t.target_chembl_id,
      name: t.target_name,
      source: 'chembl',
      action_type: t.action_type,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[drugToGenes] Error:', error);
    return [{ _error: `Gene target lookup for drug failed (source: chembl): ${msg}. Try drug_search first to verify the drug name, or try again later.` } as any];
  }
}

export async function drugToTrials(drugName: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  const trials = await trialSearch(drugName, { limit: 10 });
  return trials.map(t => ({
    nct_id: t.nct_id,
    title: t.title,
    status: t.status,
  }));
}

export async function drugToAdverseEvents(drugName: string): Promise<Array<{ reaction?: string; frequency?: string; source?: string }>> {
  try {
    const conn = connectionManager.getConnection('openfda');
    
    const response = await conn.request(
      `/drug/event.json?search=openfda.substance_name:${encodeURIComponent(drugName)}&limit=20`
    ) as OpenFDAEventResponse;
    
    return (response.results || []).slice(0, 20).map(r => ({
      reaction: r.reactions?.[0]?.reactionmeddrapt,
      frequency: undefined,
      source: 'openfda',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[drugToAdverseEvents] Error:', error);
    return [{ _error: `Adverse event lookup for drug failed (source: openfda): ${msg}. The data source may be temporarily unavailable or the drug name may not match.` } as any];
  }
}

export async function diseaseToDrugs(diseaseQuery: string): Promise<Array<{ drug_name: string; source: string; phase?: string }>> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    
    const searchQuery = `query($name: String!) {
      search(queryString: $name, entityNames: ["disease"], page: {index: 0, size: 1}) {
        hits { id name entity }
      }
    }`;
    
    const searchRaw = await conn.request(searchQuery, { name: diseaseQuery }) as any;
    const searchData = JSON.parse(JSON.stringify(searchRaw));
    const diseaseId = searchData?.data?.search?.hits?.[0]?.id;
    
    if (!diseaseId) {
      return [{ _error: `No OpenTargets entry found for disease '${diseaseQuery}'. Try disease_search first to verify the disease name or ID.` } as any];
    }
    
    const drugQuery = `query($efoId: String!) {
      disease(efoId: $efoId) {
        id name
        drugAndClinicalCandidates {
          rows { maxClinicalStage drug { id name drugType } }
        }
      }
    }`;
    
    const drugRaw = await conn.request(drugQuery, { efoId: diseaseId }) as any;
    const drugData = JSON.parse(JSON.stringify(drugRaw));
    const rows = drugData?.data?.disease?.drugAndClinicalCandidates?.rows || [];
    
    return rows.slice(0, 20).map((r: { maxClinicalStage?: string; drug?: { name?: string } }) => ({
      drug_name: r.drug?.name || '',
      source: 'opentargets',
      phase: r.maxClinicalStage || undefined,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Drug lookup for disease failed (source: opentargets): ${msg}. Try disease_search first to verify the disease name, or try again later.` } as any];
  }
}

export async function diseaseToGenes(diseaseId: string): Promise<Array<{ gene_symbol: string; name: string; source: string; score?: number }>> {
  try {
    const conn = connectionManager.getConnection('disgenet');
    
    const response = await conn.request(
      `/api/v1/disease/${encodeURIComponent(diseaseId)}?format=json`
    ) as DisgenetGeneResponse;
    
    return (response.results || []).slice(0, 20).map(r => ({
      gene_symbol: r.geneSymbol,
      name: r.geneName,
      source: r.geneDatasource,
      score: r.score,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[diseaseToGenes] Error:', error);
    return [{ _error: `Gene association lookup for disease failed (source: disgenet): ${msg}. Try disease_search first to verify the disease ID, or try again later.` } as any];
  }
}

export async function diseaseToTrials(diseaseQuery: string): Promise<Array<{ nct_id: string; title?: string; status?: string }>> {
  const trials = await trialSearch(diseaseQuery, { limit: 10 });
  return trials.map(t => ({
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
    const response = await fetch('https://reactome.org/AnalysisService/identifiers/projection', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: geneSymbols.join('\n'),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json() as ReactomeAnalysisResponse;
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
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Gene enrichment analysis failed (source: reactome): ${msg}. Ensure at least 3 valid gene symbols are provided, or try again later.` } as any];
  }
}

export interface DiscoverResult {
  entity_type: string;
  identifier: string;
  name: string;
  source?: string;
  description?: string;
  matches?: Array<{ type: string; id: string; name: string; score: number }>;
}

export async function discover(query: string): Promise<DiscoverResult[]> {
  const results: DiscoverResult[] = [];
  
  const [geneResults, variantResults, drugResults, diseaseResults] = await Promise.allSettled([
    geneSearch(query, { limit: 3 }),
    variantSearch({ query, limit: 3 }),
    drugSearch(query, { limit: 3 }),
    diseaseSearch(query, { limit: 3 }),
  ]);
  
  if (geneResults.status === 'fulfilled' && geneResults.value.length > 0) {
    results.push({
      entity_type: 'gene',
      identifier: geneResults.value[0].symbol,
      name: geneResults.value[0].name,
      source: 'mygene',
    });
  }
  
  if (variantResults.status === 'fulfilled' && variantResults.value.length > 0) {
    results.push({
      entity_type: 'variant',
      identifier: variantResults.value[0].id,
      name: variantResults.value[0].id,
      source: 'myvariant',
    });
  }
  
  if (drugResults.status === 'fulfilled' && drugResults.value.length > 0) {
    results.push({
      entity_type: 'drug',
      identifier: drugResults.value[0].name,
      name: drugResults.value[0].name,
      source: 'mychem',
    });
  }
  
  if (diseaseResults.status === 'fulfilled' && diseaseResults.value.length > 0) {
    results.push({
      entity_type: 'disease',
      identifier: diseaseResults.value[0].disease_id,
      name: diseaseResults.value[0].name,
      source: 'mydisease',
    });
  }
  
  if (results.length === 0) {
    try {
      const conn = connectionManager.getConnection('ols4');
      const response = await conn.request(
        `/api/search?q=${encodeURIComponent(query)}&size=3`
      ) as OLSResponse;
      
      if (response.response?.docs?.length) {
        for (const doc of response.response.docs) {
          results.push({
            entity_type: doc.type || 'unknown',
            identifier: doc.iri || doc.obo_id || '',
            name: doc.label || query,
            source: doc.ontology_name || 'ols',
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
    searches.push({ entity: 'trial', promise: trialSearch(query, { limit }) });
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
          const { articleGet } = await import('./article.js');
          data = await articleGet(input.id, input.sections);
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
  results?: Array<{ stId: string; name: string }>;
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

interface ChemblTargetResponse {
  targets?: Array<{
    target_chembl_id: string;
    target_name: string;
    action_type?: string;
  }>;
}

interface ChemblMechanismResponse {
  mechanisms?: Array<{
    molecule_name?: string;
    disease_name?: string;
    trial_phase?: string;
  }>;
}

interface OpenFDAEventResponse {
  results?: Array<{
    reactions?: Array<{ reactionmeddrapt?: string }>;
  }>;
}

interface DisgenetGeneResponse {
  results?: Array<{
    geneSymbol: string;
    geneName: string;
    geneDatasource: string;
    score?: number;
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
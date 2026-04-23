import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';

const SECTION_TIMEOUT_MS = 8000;

export interface DrugSearchOptions {
  drug_type?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface DrugSearchResult {
  name: string;
  uichem_id: string;
  inchi_key?: string;
  synonyms?: string[];
  molecular_formula?: string;
  molecular_weight?: number;
}

export interface DrugGetOptions {
  sections?: string[];
}

export interface DrugResult {
  name: string;
  uichem_id: string;
  aliases?: string[];
  molecular_formula?: string;
  molecular_weight?: number;
  smiles?: string;
  inchi?: string;
  inchi_key?: string;
  sections?: Record<string, unknown>;
}

export interface DrugSearchResult extends DrugResult {
  _score?: number;
}

export async function drugSearch(
  query: string,
  options: DrugSearchOptions = {}
): Promise<DrugSearchResult[]> {
  const { drug_type, source, limit = 10, offset = 0 } = options;
  
  const conn = connectionManager.getConnection('mychem');
  
  const queryParams = new URLSearchParams({
    q: query,
    fields: 'name,uichem,inchi,smiles,mw,rtb',
    size: String(limit),
    from: String(offset),
  });
  
  if (drug_type) {
    queryParams.set('type', drug_type);
  }
  
  const response = await conn.request(`/search?${queryParams.toString()}`) as MyChemSearchResponse;
  
  return (response.hits || []).map(transformMyChemHit);
}

export async function drugGet(
  name: string,
  sections?: string[]
): Promise<DrugResult> {
  const sectionConfig = sections || ['core'];
  
  const conn = connectionManager.getConnection('mychem');
  
  const queryParams = new URLSearchParams({
    q: `name:"${name}" OR ${name}`,
    fields: 'name,uichem,inchi,smiles,mw,rtb,xref,chiral,unii',
    size: '1',
  });
  
  const response = await conn.request(`/get?${queryParams.toString()}`) as MyChemGetResponse;
  
  if (!response.hits || response.hits.length === 0) {
    throw new Error(`Drug '${name}' not found. Try drug_search to find valid drug names.`);
  }
  
  const drug = response.hits[0];
  const result: DrugResult = {
    name: drug.name,
    uichem_id: drug.uichem,
    smiles: drug.smiles,
    inchi: drug.inchi,
    inchi_key: drug.inchi_key,
    molecular_weight: drug.mw,
    molecular_formula: drug.formula,
  };
  
  if (drug.unii) {
    result.aliases = [drug.unii];
  }
  
  const sectionsToFetch = sectionConfig.includes('all') 
    ? ['us_regulatory', 'eu_regulatory', 'who_regulatory', 'safety', 'targets', 'indications']
    : sectionConfig.filter(s => s !== 'core');

  if (sectionsToFetch.length > 0) {
    const sectionPromises = sectionsToFetch.map(section => {
      return fetchWithTimeout(async () => {
        switch (section) {
          case 'us_regulatory': return { section: 'us_regulatory', data: await fetchUSRegulatory(drug.uichem) };
          case 'eu_regulatory': return { section: 'eu_regulatory', data: await fetchEURegulatory(drug.uichem) };
          case 'who_regulatory': return { section: 'who_regulatory', data: await fetchWHORegulatory(drug.uichem) };
          case 'safety': return { section: 'safety', data: await fetchSafety(drug.uichem) };
          case 'targets': return { section: 'targets', data: await fetchTargets(result.inchi_key || '') };
          case 'indications': return { section: 'indications', data: await fetchIndications(result.inchi_key || '') };
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

async function fetchUSRegulatory(uichemId: string): Promise<{ fda_status?: string; ndc_codes?: string[]; label?: string }> {
  try {
    const conn = connectionManager.getConnection('openfda');
    
    const response = await conn.request(
      `/drug/label.json?search=openfda.uichem.accession:${encodeURIComponent(uichemId)}&limit=1`
    ) as OpenFDAResponse;
    
    if (response.results && response.results.length > 0) {
      const label = response.results[0];
      return {
        fda_status: label.effective_time ? 'approved' : 'unknown',
        ndc_codes: label.openfda?.ndc_code,
        label: label.brand_name?.[0],
      };
    }
  } catch {
    return {};
  }
  return {};
}

async function fetchEURegulatory(uichemId: string): Promise<{ authorized?: boolean; url?: string }> {
  try {
    return { authorized: false };
  } catch {
    return {};
  }
}

async function fetchWHORegulatory(uichemId: string): Promise<{ prequalified?: boolean; url?: string }> {
  try {
    return { prequalified: false };
  } catch {
    return {};
  }
}

async function fetchSafety(uichemId: string): Promise<{ box_warning?: string; warnings?: string[]; adverse_reactions?: string[] }> {
  try {
    const conn = connectionManager.getConnection('openfda');
    
    const response = await conn.request(
      `/drug/label.json?search=openfda.uichem.accession:${encodeURIComponent(uichemId)}&limit=1`
    ) as OpenFDAResponse;
    
    if (response.results && response.results.length > 0) {
      const label = response.results[0];
      return {
        box_warning: label.boxed_warning?.[0],
        warnings: label.warnings,
        adverse_reactions: label.adverse_reactions,
      };
    }
  } catch {
    return {};
  }
  return {};
}

async function fetchTargets(inchiKey: string): Promise<Array<{ gene_symbol: string; name: string; action_type?: string; source: string }>> {
  if (!inchiKey) return [];
  try {
    const conn = connectionManager.getConnection('chembl');
    
    const response = await conn.request(
      `/target?molecule_chembl_id=${encodeURIComponent(inchiKey)}&format=json`
    ) as ChemblTargetResponse;
    
    return (response.targets || []).slice(0, 20).map(t => ({
      gene_symbol: t.target_chembl_id,
      name: t.target_name,
      action_type: t.action_type,
      source: 'chembl',
    }));
  } catch {
    return [];
  }
}

async function fetchIndications(inchiKey: string): Promise<Array<{ disease_name: string; phase: string; source: string }>> {
  if (!inchiKey) return [];
  try {
    const conn = connectionManager.getConnection('chembl');
    
    const response = await conn.request(
      `/mechanism?molecule_chembl_id=${encodeURIComponent(inchiKey)}&format=json`
    ) as ChemblMechanismResponse;
    
    return (response.mechanisms || []).slice(0, 20).map(m => ({
      disease_name: m.disease_name || '',
      phase: m.trial_phase || '',
      source: 'chembl',
    }));
  } catch {
    return [];
  }
}

interface MyChemSearchResponse {
  hits: Array<{
    name: string;
    uichem: string;
    inchi?: string;
    inchi_key?: string;
    smiles?: string;
    mw?: number;
    formula?: string;
  }>;
}

interface MyChemGetResponse {
  hits: Array<{
    name: string;
    uichem: string;
    inchi?: string;
    inchi_key?: string;
    smiles?: string;
    mw?: number;
    formula?: string;
    unii?: string;
  }>;
}

interface OpenFDAResponse {
  results?: Array<{
    effective_time?: number;
    openfda?: {
      ndc_code?: string[];
    };
    brand_name?: string[];
    boxed_warning?: string[];
    warnings?: string[];
    adverse_reactions?: string[];
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
    disease_name?: string;
    trial_phase?: string;
  }>;
}

export function transformMyChemHit(hit: MyChemSearchResponse['hits'][0]): DrugSearchResult {
  return {
    name: hit.name,
    uichem_id: hit.uichem,
    inchi_key: hit.inchi_key,
    smiles: hit.smiles,
    molecular_formula: hit.formula,
    molecular_weight: hit.mw,
  };
}

export function transformMyChemResponse(data: MyChemGetResponse['hits'][0]): DrugResult {
  return {
    name: data.name,
    uichem_id: data.uichem,
    inchi: data.inchi,
    inchi_key: data.inchi_key,
    smiles: data.smiles,
    molecular_weight: data.mw,
    molecular_formula: data.formula,
  };
}
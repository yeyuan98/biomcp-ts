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
  
  const response = await conn.request(`/query?${queryParams.toString()}`) as MyChemSearchResponse;
  
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
  
  const response = await conn.request(`/query?${queryParams.toString()}`) as MyChemGetResponse;
  
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
          case 'us_regulatory': return { section: 'us_regulatory', data: await fetchUSRegulatory(name) };
          case 'eu_regulatory': return { section: 'eu_regulatory', data: await fetchEURegulatory(name) };
          case 'who_regulatory': return { section: 'who_regulatory', data: await fetchWHORegulatory(name) };
          case 'safety': return { section: 'safety', data: await fetchSafety(name) };
          case 'targets': return { section: 'targets', data: await fetchTargets(name) };
          case 'indications': return { section: 'indications', data: await fetchIndications(name) };
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

async function fetchUSRegulatory(drugName: string): Promise<{ fda_status?: string; ndc_codes?: string[]; label?: string }> {
  try {
    const conn = connectionManager.getConnection('openfda');
    
    const response = await conn.request(
      `/drug/label.json?search=openfda.generic_name:${encodeURIComponent(drugName)}&limit=1`
    ) as OpenFDAResponse;
    
    if (response.results && response.results.length > 0) {
      const label = response.results[0];
      return {
        fda_status: label.effective_time ? 'approved' : 'unknown',
        ndc_codes: label.openfda?.ndc_code,
        label: label.openfda?.brand_name?.[0],
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { _error: `US regulatory lookup failed (source: openfda): ${msg}. The data source may be temporarily unavailable.` } as any;
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

async function fetchSafety(drugName: string): Promise<{ box_warning?: string; warnings?: string[]; adverse_reactions?: string[] }> {
  try {
    const conn = connectionManager.getConnection('openfda');
    
    const response = await conn.request(
      `/drug/label.json?search=openfda.generic_name:${encodeURIComponent(drugName)}&limit=1`
    ) as OpenFDAResponse;
    
    if (response.results && response.results.length > 0) {
      const label = response.results[0];
      return {
        box_warning: label.boxed_warning?.[0],
        warnings: label.warnings,
        adverse_reactions: label.adverse_reactions,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { _error: `Safety lookup failed (source: openfda): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
  return {};
}

async function resolveDrugChemblId(drugName: string): Promise<string | null> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($name: String!) {
      search(queryString: $name, entityNames: ["drug"], page: {index: 0, size: 1}) {
        hits { id name }
      }
    }`;
    const raw = await conn.request(query, { name: drugName }) as any;
    const data = JSON.parse(JSON.stringify(raw));
    return data?.data?.search?.hits?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function fetchTargets(drugName: string): Promise<Array<{ gene_symbol: string; name: string; action_type?: string; source: string }>> {
  if (!drugName) return [];
  try {
    const chemblId = await resolveDrugChemblId(drugName);
    if (!chemblId) {
      return [{ _error: `No OpenTargets entry found for drug '${drugName}'. The drug may not be in the OpenTargets database.` } as any];
    }
    
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($chemblId: String!) {
      drug(chemblId: $chemblId) {
        id name
        mechanismsOfAction {
          rows { actionType targets { id approvedSymbol } }
          uniqueActionTypes
        }
      }
    }`;
    
    const raw = await conn.request(query, { chemblId }) as any;
    const data = JSON.parse(JSON.stringify(raw));
    const rows = data?.data?.drug?.mechanismsOfAction?.rows || [];
    
    const seen = new Set<string>();
    const results: Array<{ gene_symbol: string; name: string; action_type?: string; source: string }> = [];
    for (const row of rows) {
      for (const t of row.targets || []) {
        if (!seen.has(t.approvedSymbol)) {
          seen.add(t.approvedSymbol);
          results.push({
            gene_symbol: t.approvedSymbol || '',
            name: t.approvedSymbol || '',
            action_type: row.actionType || undefined,
            source: 'opentargets',
          });
        }
      }
    }
    return results.slice(0, 20);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Target lookup failed (source: opentargets): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

async function fetchIndications(drugName: string): Promise<Array<{ disease_name: string; phase: string; source: string }>> {
  if (!drugName) return [];
  try {
    const chemblId = await resolveDrugChemblId(drugName);
    if (!chemblId) {
      return [{ _error: `No OpenTargets entry found for drug '${drugName}'. The drug may not be in the OpenTargets database.` } as any];
    }
    
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($chemblId: String!) {
      drug(chemblId: $chemblId) {
        id name
        indications {
          rows { maxClinicalStage disease { id name } }
        }
      }
    }`;
    
    const raw = await conn.request(query, { chemblId }) as any;
    const data = JSON.parse(JSON.stringify(raw));
    const rows = data?.data?.drug?.indications?.rows || [];
    
    return rows.slice(0, 20).map((r: { maxClinicalStage?: string; disease?: { name?: string } }) => ({
      disease_name: r.disease?.name || '',
      phase: r.maxClinicalStage || '',
      source: 'opentargets',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Indication lookup failed (source: opentargets): ${msg}. The data source may be temporarily unavailable.` } as any];
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
      brand_name?: string[];
    };
    boxed_warning?: string[];
    warnings?: string[];
    adverse_reactions?: string[];
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
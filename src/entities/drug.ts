import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';
import { HttpConnectionError } from '../connections/errors.js';

const SECTION_TIMEOUT_MS = 8000;

/**
 * Sections fetched for `drug_get sections:['all']`. Single source of truth —
 * the tool layer's limit-slicing list must stay identical to this.
 */
export const DRUG_ENTITY_ALL_SECTIONS = [
  'us_regulatory', 'eu_regulatory', 'who_regulatory', 'safety', 'targets', 'indications', 'adverse_events',
] as const;

export interface DrugSearchOptions {
  limit?: number;
  offset?: number;
}

export interface DrugSearchResult {
  name: string;
  chembl_id?: string;
  inchi_key?: string;
  synonyms?: string[];
  molecular_formula?: string;
  molecular_weight?: number;
  chebi_id?: string;
  unii?: string;
}

export interface DrugResult {
  name: string;
  chembl_id?: string;
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
  const { limit = 10, offset = 0 } = options;

  const conn = connectionManager.getConnection('mychem');

  const queryParams = new URLSearchParams({
    q: query,
    fields: 'chebi.name,chebi.id,chebi.formula,chebi.mass,chebi.inchikey,unii.smiles,unii.molecular_formula,unii.display_name,unii.registry_number,unichem.chembl,ndc.nonproprietaryname,ndc.substancename',
    size: String(limit),
    from: String(offset),
  });

  const response = await conn.request(`/query?${queryParams.toString()}`) as MyChemSearchResponse;

  return (response.hits || []).map(transformMyChemHit);
}

export interface BestMatchResult {
  hit: Record<string, unknown>;
  score: number;
}

const LUCENE_SPECIAL = /[+\-&|!(){}\[\]^"~*?:\\]/g;

function escapeLucene(value: string): string {
  return value.replace(LUCENE_SPECIAL, '\\$&');
}

export function resolveBestMatch(
  name: string,
  hits: Array<Record<string, unknown>>
): BestMatchResult | null {
  if (!hits || hits.length === 0) return null;

  const queryLower = name.toLowerCase();

  let bestHit: Record<string, unknown> | null = null;
  let bestScore = -1;

  for (const hit of hits) {
    let score = 0;

    const chebi = hit.chebi as Record<string, unknown> | undefined;
    const unii = hit.unii as Record<string, unknown> | undefined;
    const ndc = hit.ndc as Record<string, unknown> | undefined;

    const chebiName = (chebi?.name as string) || '';
    const displayName = (unii?.display_name as string) || '';
    const nonPropName = (ndc?.nonproprietaryname as string) || '';

    if (chebiName.toLowerCase() === queryLower) {
      score = 3;
    } else if (
      displayName.toLowerCase() === queryLower ||
      nonPropName.toLowerCase() === queryLower
    ) {
      score = 2;
    } else if (chebiName.toLowerCase().includes(queryLower)) {
      score = 1;
    }

    // Check synonym match when not already matched at a higher level
    if (score < 2) {
      const synonyms = (chebi?.name_synonyms as string[] | undefined) || [];
      if (synonyms.some(s => typeof s === 'string' && s.toLowerCase() === queryLower)) {
        score = 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestHit = hit;
    }
  }

  return bestHit ? { hit: bestHit, score: bestScore } : null;
}

/** Fields we request from MyChem when resolving a drug by name. */
const DRUG_GET_FIELDS =
  'chebi.name,chebi.formula,chebi.mass,chebi.inchi,chebi.inchikey,chebi.id,chebi.name_synonyms,unii.smiles,unii.molecular_formula,unii.display_name,unii.registry_number,unichem.chembl,ndc.nonproprietaryname,ndc.substancename';

export async function drugGet(
  name: string,
  sections?: string[],
  limit = 20
): Promise<DrugResult> {
  const sectionConfig = sections || ['core'];

  const conn = connectionManager.getConnection('mychem');

  const escaped = escapeLucene(name);

  // Single combined query covering exact match, synonyms, display names, and broad fallback.
  // resolveBestMatch scores candidates: 3=exact chebi name, 2=exact synonym/display name, 1=contains, 0=other.
  const q = `chebi.name:"${escaped}" OR chebi.name_synonyms:"${escaped}" OR unii.display_name:"${escaped}" OR ndc.nonproprietaryname:"${escaped}" OR "${escaped}"`;

  const queryParams = new URLSearchParams({
    q,
    fields: DRUG_GET_FIELDS,
    size: '5',
  });

  const response = await conn.request(
    `/query?${queryParams.toString()}`
  ) as MyChemGetResponse;

  const bestMatch = resolveBestMatch(name, response.hits || []);

  if (!bestMatch) {
    throw new Error(`Drug '${name}' not found. Try drug_search to find valid drug names.`);
  }

  const hit = bestMatch.hit;
  const chebi = hit.chebi as Record<string, unknown> | undefined;
  const unii = hit.unii as Record<string, unknown> | undefined;
  const unichem = hit.unichem as Record<string, unknown> | undefined;
  const ndc = hit.ndc as Record<string, unknown> | undefined;

  const result: DrugResult = {
    name: (chebi?.name || unii?.display_name || ndc?.nonproprietaryname || ndc?.substancename || unii?.registry_number || name) as string,
    chembl_id: (unichem?.chembl as string) || undefined,
    smiles: (unii?.smiles as string) || undefined,
    inchi: (chebi?.inchi as string) || undefined,
    inchi_key: (chebi?.inchikey as string) || undefined,
    molecular_weight: (chebi?.mass as number) || undefined,
    molecular_formula: (chebi?.formula as string) || (unii?.molecular_formula as string) || undefined,
  };

  if (unii?.registry_number) {
    result.aliases = [unii.registry_number as string];
  }

  const sectionsToFetch = sectionConfig.includes('all')
    ? [...DRUG_ENTITY_ALL_SECTIONS]
    : sectionConfig.filter(s => s !== 'core');

  // Use the original user input for external API calls (OpenFDA, OpenTargets)
  // since those databases index drugs by common names, not ChEBI canonical names.
  const lookupName = name;

  if (sectionsToFetch.length > 0) {
    // Pre-resolve shared dependencies to avoid duplicate API calls.
    const needOpenFDA = sectionsToFetch.includes('us_regulatory') || sectionsToFetch.includes('safety');
    const needOpenTargets = sectionsToFetch.includes('targets') || sectionsToFetch.includes('indications');

    const [openFDALabel, chemblId] = await Promise.all([
      needOpenFDA ? fetchOpenFDALabel(lookupName) : Promise.resolve(null),
      needOpenTargets ? resolveDrugChemblId(lookupName) : Promise.resolve(undefined),
    ]);

    const sectionPromises = sectionsToFetch.map(section => {
      return fetchWithTimeout(async () => {
        switch (section) {
          case 'us_regulatory': return { section: 'us_regulatory', data: extractUSRegulatory(openFDALabel) };
          case 'safety': return { section: 'safety', data: extractSafety(openFDALabel) };
          case 'eu_regulatory': return { section: 'eu_regulatory', data: await fetchEURegulatory(lookupName) };
          case 'who_regulatory': return { section: 'who_regulatory', data: await fetchWHORegulatory(lookupName) };
          case 'targets': return { section: 'targets', data: await fetchTargets(chemblId ?? null) };
          case 'indications': return { section: 'indications', data: await fetchIndications(chemblId ?? null) };
          case 'adverse_events': return { section: 'adverse_events', data: await fetchAdverseEvents(lookupName, limit) };
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

async function fetchOpenFDALabel(drugName: string): Promise<OpenFDAResponse['results'] | null> {
  try {
    const conn = connectionManager.getConnection('openfda');
    const response = await conn.request(
      `/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(drugName)}"&limit=1`
    ) as OpenFDAResponse;
    return response.results || null;
  } catch {
    return null;
  }
}

export interface AdverseEventReaction {
  reaction: string;
  count: number;
  source: 'openfda';
}

export interface AdverseEventsResult {
  total_reports: number;
  reactions: AdverseEventReaction[];
}

// openFDA's event endpoint searches fully-qualified field paths — the
// `openfda.*` shorthand only works on label.json. Ordered by specificity.
const FAERS_SEARCH_FIELDS = [
  'patient.drug.openfda.substance_name',
  'patient.drug.openfda.generic_name',
  'patient.drug.medicinalproduct',
] as const;

/**
 * FDA FAERS adverse reactions for a drug, ranked by report count.
 *
 * Uses the aggregated `count=patient.reaction.reactionmeddrapt.exact`
 * endpoint rather than raw event reports, so the result is a compact
 * ranked list. openFDA answers zero-match searches with HTTP 404, which
 * advances the field fallback chain instead of failing the lookup.
 */
export async function fetchAdverseEvents(drugName: string, limit = 20): Promise<AdverseEventsResult | Array<{ _error: string }>> {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 1000) : 20;
  try {
    const conn = connectionManager.getConnection('openfda');
    const phrase = (field: string) => `${field}:"${drugName.replace(/"/g, '\\"')}"`;

    for (const field of FAERS_SEARCH_FIELDS) {
      let total: number;
      try {
        const probe = await conn.request(
          `/drug/event.json?search=${encodeURIComponent(phrase(field))}&limit=1`
        ) as { meta?: { results?: { total?: number } } };
        total = probe?.meta?.results?.total ?? 0;
        if (!total) continue;
      } catch (error) {
        if (error instanceof HttpConnectionError && error.status === 404) continue;
        throw error;
      }

      const counts = await conn.request(
        `/drug/event.json?search=${encodeURIComponent(phrase(field))}&count=${encodeURIComponent('patient.reaction.reactionmeddrapt.exact')}&limit=${safeLimit}`
      ) as { results?: Array<{ term?: string; count?: number }> };

      const reactions = (counts?.results ?? [])
        .filter((r): r is { term: string; count: number } => typeof r.term === 'string' && typeof r.count === 'number')
        .map(r => ({ reaction: r.term, count: r.count, source: 'openfda' as const }));

      return { total_reports: total, reactions };
    }

    return { total_reports: 0, reactions: [] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchAdverseEvents] Error:', error);
    return [{ _error: `Adverse event lookup for drug failed (source: openfda): ${msg}. The data source may be temporarily unavailable or the drug name may not match.` }];
  }
}

function extractUSRegulatory(results: OpenFDAResponse['results'] | null): { fda_status?: string; ndc_codes?: string[]; label?: string; _error?: string } {
  if (!results || results.length === 0) return {};
  const label = results[0];
  return {
    fda_status: label.effective_time ? 'approved' : 'unknown',
    ndc_codes: label.openfda?.ndc_code,
    label: label.openfda?.brand_name?.[0],
  };
}

function extractSafety(results: OpenFDAResponse['results'] | null): { box_warning?: string; warnings?: string[]; adverse_reactions?: string[]; _error?: string } {
  if (!results || results.length === 0) return {};
  const label = results[0];
  return {
    box_warning: label.boxed_warning?.[0],
    warnings: label.warnings,
    adverse_reactions: label.adverse_reactions,
  };
}

async function fetchEURegulatory(_drugName: string): Promise<{ authorized?: boolean; url?: string }> {
  return { authorized: false };
}

async function fetchWHORegulatory(_drugName: string): Promise<{ prequalified?: boolean; url?: string }> {
  return { prequalified: false };
}

async function resolveDrugChemblId(drugName: string): Promise<string | null> {
  try {
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($name: String!) {
      search(queryString: $name, entityNames: ["drug"], page: {index: 0, size: 1}) {
        hits { id name }
      }
    }`;
    const raw = await conn.request(query, { name: drugName }, { rootField: 'search' }) as any;
    const data = JSON.parse(JSON.stringify(raw));
    return data?.data?.search?.hits?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function fetchTargets(chemblId: string | null): Promise<Array<{ gene_symbol: string; name: string; action_type?: string; source: string }>> {
  if (!chemblId) {
    return [{ _error: 'No OpenTargets entry found for this drug. The drug may not be in the OpenTargets database.' } as any];
  }
  try {
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

    const raw = await conn.request(query, { chemblId }, { rootField: 'drug' }) as any;
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

async function fetchIndications(chemblId: string | null): Promise<Array<{ disease_name: string; phase: string; source: string }>> {
  if (!chemblId) {
    return [{ _error: 'No OpenTargets entry found for this drug. The drug may not be in the OpenTargets database.' } as any];
  }
  try {
    const conn = connectionManager.getConnection('opentargets');
    const query = `query($chemblId: String!) {
      drug(chemblId: $chemblId) {
        id name
        indications {
          rows { maxClinicalStage disease { id name } }
        }
      }
    }`;

    const raw = await conn.request(query, { chemblId }, { rootField: 'drug' }) as any;
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
  hits: Array<Record<string, unknown>>;
}

interface MyChemGetResponse {
  hits: Array<Record<string, unknown>>;
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

export function transformMyChemHit(hit: Record<string, unknown>): DrugSearchResult {
  const chebi = hit.chebi as Record<string, unknown> | undefined;
  const unii = hit.unii as Record<string, unknown> | undefined;
  const unichem = hit.unichem as Record<string, unknown> | undefined;
  const ndc = hit.ndc as Record<string, unknown> | undefined;

  return {
    name: (chebi?.name || unii?.display_name || ndc?.nonproprietaryname || ndc?.substancename || unii?.registry_number || '') as string,
    chembl_id: (unichem?.chembl as string) || undefined,
    inchi_key: (chebi?.inchikey as string) || undefined,
    molecular_formula: (chebi?.formula as string) || (unii?.molecular_formula as string) || undefined,
    molecular_weight: (chebi?.mass as number) || undefined,
    chebi_id: (chebi?.id as string) || undefined,
    unii: (unii?.registry_number as string) || undefined,
  };
}

export function transformMyChemResponse(data: Record<string, unknown>): DrugResult {
  const chebi = data.chebi as Record<string, unknown> | undefined;
  const unii = data.unii as Record<string, unknown> | undefined;
  const unichem = data.unichem as Record<string, unknown> | undefined;

  return {
    name: (chebi?.name || unii?.display_name || '') as string,
    chembl_id: (unichem?.chembl as string) || undefined,
    inchi: (chebi?.inchi as string) || undefined,
    inchi_key: (chebi?.inchikey as string) || undefined,
    smiles: (unii?.smiles as string) || undefined,
    molecular_weight: (chebi?.mass as number) || undefined,
    molecular_formula: (chebi?.formula as string) || undefined,
  };
}

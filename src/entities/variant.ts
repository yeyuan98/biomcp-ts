import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';

const SECTION_TIMEOUT_MS = 8000;

export interface VariantSearchOptions {
  query?: string;
  gene?: string;
  significance?: 'benign' | 'likely_benign' | 'pathogenic' | 'likely_pathogenic' | 'uncertain';
  max_frequency?: number;
  limit?: number;
  offset?: number;
}

export interface VariantSearchResult {
  id: string;
  gene?: string;
  hgvs_p?: string;
  hgvs_c?: string;
  significance?: string;
  clinvar_stars?: number;
  gnomad_af?: number;
}

export interface VariantGetOptions {
  sections?: string[];
}

export interface VariantResult {
  id: string;
  gene?: string;
  hgvs_p?: string;
  hgvs_c?: string;
  rsid?: string;
  cosmic_id?: string;
  significance?: string;
  conditions?: string[];
  sections?: Record<string, unknown>;
}

export interface FrequencySection {
  gnomad_af?: number;
  exac_af?: number;
  popul_max?: string;
  population_breakdown?: Record<string, number>;
}

export interface PredictionsSection {
  cadd_score?: number;
  cadd_phred?: number;
  sift_score?: number;
  sift_pred?: string;
  polyphen_score?: number;
  polyphen_pred?: string;
  revel_score?: number;
  vest_score?: number;
  conservation?: {
    phylop?: number;
    phastcons?: number;
    gerp?: number;
  };
  other?: {
    alphamissense?: number;
    clinpred?: number;
    metarnn?: number;
    bayesdel?: number;
  };
}

export interface ClinicalSection {
  clinvar?: {
    id?: number;
    significance?: string;
    stars?: number;
    conditions?: string[];
    review_status?: string;
    submitters?: string[];
  };
  cancer?: {
    oncogenic?: string;
    effect?: string;
    therapies?: Array<{ name: string; nct_id?: string }>;
  };
  civic?: {
    id?: number;
    clinical_significance?: string;
    evidence_score?: number;
  };
  gwas?: Array<{ trait: string; p_value?: number }>;
}

export interface AlphaGenomeSection {
  expression_lfc?: Record<string, number>;
  splice_score?: Record<string, number>;
  chromatin_score?: Record<string, number>;
  top_gene?: string;
  scorers?: string[];
}

export interface OncoKbAnnotation {
  oncogenic?: string;
  level?: string;
  effect?: string;
  therapies?: Array<{ name: string; level?: string; drugs?: string[] }>;
}

const VARIANT_SEARCH_FILTERS = [
  'gene', 'hgvsp', 'hgvsc', 'rsid', 'protein_alias',
  'significance', 'max_frequency', 'min_cadd', 'consequence',
  'review_status', 'population', 'revel_min', 'gerp_min',
  'tumor_site', 'condition', 'impact', 'lof', 'has', 'missing', 'therapy'
] as const;

const VARIANT_GET_SECTIONS = ['core', 'frequency', 'predictions', 'clinical', 'alphagenome'] as const;

export async function variantSearch(
  options: VariantSearchOptions
): Promise<VariantSearchResult[]> {
  const { query, gene, significance, max_frequency, limit = 10, offset = 0 } = options;
  
  const conn = connectionManager.getConnection('myvariant');
  
  const queryParams = new URLSearchParams({
    size: String(limit),
    from: String(offset),
    fields: 'gene,rsid,hgvs,significance,clinvar_stars,gnomad_af',
  });
  
  if (query) {
    queryParams.set('q', query);
  }
  
  if (gene) {
    queryParams.set('gene', gene);
  }
  
  if (significance) {
    queryParams.set('significance', significance);
  }
  
  if (max_frequency !== undefined) {
    queryParams.set('max_frequency', String(max_frequency));
  }
  
  const response = await conn.request(`/query?${queryParams.toString()}`) as MyVariantSearchResponse;
  
  return (response.hits || []).map(transformMyVariantHit);
}

export async function variantGet(
  id: string,
  sections?: string[]
): Promise<VariantResult> {
  const sectionConfig = sections || ['core'];
  
  const conn = connectionManager.getConnection('myvariant');
  
  const response = await conn.request(
    `/variant/${id}?fields=gene,rsid,hgvs,significance,clinvar,gnomad,cadd,sift,polyphen,dbsnp,cosmic`
  ) as MyVariantGetResponse;
  
  if (!response) {
    throw new Error(`Variant '${id}' not found`);
  }
  
  const variant: VariantResult = {
    id: response.dbsnp?.rsid || response.rsid || id,
    gene: response.gene?.symbol,
    hgvs_p: response.hgvs?.p,
    hgvs_c: response.hgvs?.c,
    rsid: response.dbsnp?.rsid || response.rsid,
    cosmic_id: response.cosmic?.cosmic_id,
  };
  
  if (response.clinvar) {
    variant.significance = response.clinvar.significance;
    variant.conditions = response.clinvar.conditions;
  }
  
  const sectionsToFetch = sectionConfig.includes('all')
    ? [...VARIANT_GET_SECTIONS]
    : sectionConfig.filter(s => VARIANT_GET_SECTIONS.includes(s as typeof VARIANT_GET_SECTIONS[number]));
  
  const sectionPromises = sectionsToFetch.map(section => {
    return fetchWithTimeout(async () => {
      switch (section) {
        case 'frequency':
          return { section: 'frequency', data: await fetchFrequencySection(response) };
        case 'predictions':
          return { section: 'predictions', data: await fetchPredictionsSection(response) };
        case 'clinical':
          return { section: 'clinical', data: await fetchClinicalSection(response, variant.gene) };
        case 'alphagenome':
          return { section: 'alphagenome', data: await fetchAlphaGenomeSection(variant) };
        default:
          return { section, data: null };
      }
    }, SECTION_TIMEOUT_MS);
  });

  if (sectionPromises.length > 0) {
    const settledResults = await Promise.allSettled(sectionPromises);
    variant.sections = {};
    
    for (let i = 0; i < settledResults.length; i++) {
      const settled = settledResults[i];
      if (settled.status === 'fulfilled' && settled.value.data) {
        const sectionData = settled.value.data as { section: string; data: unknown };
        (variant.sections as Record<string, unknown>)[sectionData.section] = sectionData.data;
      } else if (settled.status === 'fulfilled' && settled.value.error) {
        const sectionResult = settled.value as { error?: string };
        (variant.sections as Record<string, unknown>)[sectionsToFetch[i]] = {
          error: sectionResult.error
        };
      } else if (settled.status === 'rejected') {
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        (variant.sections as Record<string, unknown>)[sectionsToFetch[i]] = {
          error: `Section '${sectionsToFetch[i]}' fetch failed: ${reason}. The data source may be temporarily unavailable.`
        };
      }
    }
  }
  
  return variant;
}

async function fetchFrequencySection(variant: MyVariantGetResponse): Promise<FrequencySection | null> {
  try {
    const conn = connectionManager.getConnection('gnomad');
    
    const query = `query($rsid: String!) {
      snp(rsid: $rsid) {
        genome {
          af: alleleFrequencies {
            population: population
            af: alleleFrequency
          }
        }
      }
    }`;
    
    const vars = { rsid: variant.dbsnp?.rsid || variant.rsid?.replace('rs', '') || '' };
    const rawResponse = await conn.request(query, vars) as GnomadFreqResponse;
    const parsed = JSON.parse(JSON.stringify(rawResponse));
    const freqs = parsed.data?.snp?.genome?.af || [];
    
    const breakdown: Record<string, number> = {};
    let maxAf = 0;
    let maxPop = 'nfe';
    
    for (const f of freqs) {
      if (f.af > maxAf) {
        maxAf = f.af;
        maxPop = f.population;
      }
      breakdown[f.population] = f.af;
    }
    
    return {
      gnomad_af: variant.gnomad?.af,
      population_breakdown: breakdown,
      popul_max: maxPop,
    };
  } catch {
    if (variant.gnomad) {
      return {
        gnomad_af: variant.gnomad.af,
      };
    }
    return null;
  }
}

async function fetchPredictionsSection(variant: MyVariantGetResponse): Promise<PredictionsSection | null> {
  const result: PredictionsSection = {};
  
  if (variant.cadd) {
    result.cadd_score = variant.cadd.score;
    result.cadd_phred = variant.cadd.phred;
  }
  
  if (variant.sift) {
    result.sift_score = variant.sift.score;
    result.sift_pred = variant.sift.pred;
  }
  
  if (variant.polyphen) {
    result.polyphen_score = variant.polyphen.score;
    result.polyphen_pred = variant.polyphen.pred;
  }
  
  if (variant.revel) {
    result.revel_score = variant.revel.score;
  }
  
  if (variant.vest) {
    result.vest_score = variant.vest.score;
  }
  
  if (variant.gerp) {
    result.conservation = {
      gerp: variant.gerp.score,
    };
  }
  
  if (variant.phylop) {
    result.conservation = result.conservation || {};
    result.conservation.phylop = variant.phylop.score;
  }
  
  if (variant.phastcons) {
    result.conservation = result.conservation || {};
    result.conservation.phastcons = variant.phastcons.score;
  }
  
  if (variant.alphamissense) {
    result.other = { alphamissense: variant.alphamissense.score };
  }
  
  if (variant.clinpred) {
    result.other = result.other || {};
    result.other.clinpred = variant.clinpred.score;
  }
  
  if (variant.metarnn) {
    result.other = result.other || {};
    result.other.metarnn = variant.metarnn.score;
  }
  
  if (variant.bayesdel) {
    result.other = result.other || {};
    result.other.bayesdel = variant.bayesdel.score;
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

async function fetchClinicalSection(variant: MyVariantGetResponse, gene?: string): Promise<ClinicalSection | null> {
  const result: ClinicalSection = {};
  
  if (variant.clinvar) {
    result.clinvar = {
      id: variant.clinvar.id,
      significance: variant.clinvar.significance,
      stars: variant.clinvar.stars,
      conditions: variant.clinvar.conditions,
      review_status: variant.clinvar.review_status,
      submitters: variant.clinvar.submitters,
    };
  }
  
  if (gene) {
    try {
      const civicConn = connectionManager.getConnection('civic');
      const civicQuery = `query($gene: String!, $hgvsp: String!) {
        variants(gene: $gene, proteinChange: $hgvsp) {
          id
          clinicalSignificance
          evidenceScore
        }
      }`;
      const civicVars = { gene, hgvsp: variant.hgvs?.p || '' };
      const civicRaw = await civicConn.request(civicQuery, civicVars) as CivicVariantResponse;
      const civicParsed = JSON.parse(JSON.stringify(civicRaw));
      const civicData = civicParsed.data?.variants?.[0];
      if (civicData) {
        result.civic = {
          id: civicData.id,
          clinical_significance: civicData.clinicalSignificance,
          evidence_score: civicData.evidenceScore,
        };
      }
    } catch {
      // CIViC not available
    }
  }
  
  if (gene && variant.hgvs?.p) {
    try {
      const oncokbResult = await fetchOncoKbAnnotation(gene, variant.hgvs.p);
      if (oncokbResult) {
        result.cancer = {
          oncogenic: oncokbResult.oncogenic,
          effect: oncokbResult.effect,
          therapies: oncokbResult.therapies || [],
        };
      }
    } catch {
      // OncoKB not available
    }
  }
  
  return Object.keys(result).length > 0 ? result : null;
}

async function fetchAlphaGenomeSection(variant: VariantResult): Promise<AlphaGenomeSection | null> {
  try {
    const grpcConn = connectionManager.getConnection('alphagenome');
    
    const result: AlphaGenomeSection = {
      scorers: ['GeneMaskLFCScorer', 'GeneMaskSplicingScorer', 'CenterMaskScorer'],
    };
    
    const expressionScores = await grpcConn.request({
      variant: variant.id,
      scorer: 'GeneMaskLFCScorer',
    }) as Record<string, number>;
    
    if (expressionScores) {
      result.expression_lfc = expressionScores;
      const entries = Object.entries(expressionScores);
      if (entries.length > 0) {
        result.top_gene = entries[0][0];
      }
    }
    
    const spliceScores = await grpcConn.request({
      variant: variant.id,
      scorer: 'GeneMaskSplicingScorer',
    }) as Record<string, number>;
    
    if (spliceScores) {
      result.splice_score = spliceScores;
    }
    
    const chromScores = await grpcConn.request({
      variant: variant.id,
      scorer: 'CenterMaskScorer',
    }) as Record<string, number>;
    
    if (chromScores) {
      result.chromatin_score = chromScores;
    }
    
    return result;
  } catch {
    return null;
  }
}

export async function fetchOncoKbAnnotation(gene: string, proteinChange: string): Promise<OncoKbAnnotation | null> {
  try {
    const conn = connectionManager.getConnection('oncokb');
    
    const queryParams = new URLSearchParams({
      byProteinChange: 'true',
      alteration: proteinChange.replace(/p\./, ''),
      gene: gene,
    });
    
    const response = await conn.request(`/annotate/mutations/byProteinChange?${queryParams.toString()}`) as OncoKbResponse;
    
    if (!response) {
      return null;
    }
    
    const therapies: Array<{ name: string; level?: string; drugs?: string[] }> = [];
    
    if (response.associatedTreatments) {
      for (const t of response.associatedTreatments) {
        therapies.push({
          name: t.drugs?.map((d: { drugName: string }) => d.drugName).join(', ') || t.drugs?.[0]?.drugName || '',
          level: t.level,
        });
      }
    }
    
    return {
      oncogenic: response.oncogenic,
      level: response.highestLevel,
      effect: response.mutationEffect,
      therapies,
    };
  } catch {
    return null;
  }
}

export function getVariantSearchFilters(): readonly string[] {
  return VARIANT_SEARCH_FILTERS;
}

export function getVariantGetSections(): readonly string[] {
  return VARIANT_GET_SECTIONS;
}

interface MyVariantSearchResponse {
  hits: Array<{
    _id: string;
    gene?: { symbol: string };
    rsid?: string;
    dbsnp?: { rsid: string };
    hgvs?: { p: string; c: string };
    clinical_significance?: string;
    clinvar?: { stars: number };
    gnomad?: { af: number };
  }>;
}

interface MyVariantGetResponse {
  _id: string;
  rsid?: string;
  dbsnp?: { rsid: string };
  cosmic?: { cosmic_id: string };
  gene?: { symbol: string };
  hgvs?: { p: string; c: string };
  clinvar?: {
    id?: number;
    significance?: string;
    conditions?: string[];
    review_status?: string;
    submitters?: string[];
    stars?: number;
  };
  gnomad?: {
    af?: number;
    exac_af?: number;
    populations?: Record<string, number>;
  };
  cadd?: {
    score?: number;
    phred?: number;
  };
  sift?: { score?: number; pred?: string };
  polyphen?: { score?: number; pred?: string };
  revel?: { score?: number };
  vest?: { score?: number };
  gerp?: { score?: number };
  phylop?: { score?: number };
  phastcons?: { score?: number };
  alphamissense?: { score?: number };
  clinpred?: { score?: number };
  metarnn?: { score?: number };
  bayesdel?: { score?: number };
}

interface GnomadFreqResponse {
  data?: {
    snp?: {
      genome?: {
        af?: Array<{ population: string; af: number }>;
      };
    };
  };
}

interface CivicVariantResponse {
  data?: {
    variants?: Array<{
      id: number;
      clinicalSignificance?: string;
      evidenceScore?: number;
    }>;
  };
}

interface OncoKbResponse {
  oncogenic?: string;
  highestLevel?: string;
  mutationEffect?: string;
  associatedTreatments?: Array<{
    drugs?: Array<{ drugName: string }>;
    level?: string;
  }>;
}

export function transformMyVariantHit(hit: MyVariantSearchResponse['hits'][0]): VariantSearchResult {
  return {
    id: hit.dbsnp?.rsid || hit.rsid || hit._id,
    gene: hit.gene?.symbol,
    hgvs_p: hit.hgvs?.p,
    hgvs_c: hit.hgvs?.c,
    significance: hit.clinical_significance,
    clinvar_stars: hit.clinvar?.stars,
    gnomad_af: hit.gnomad?.af,
  };
}
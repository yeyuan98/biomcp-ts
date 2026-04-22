import { connectionManager } from '../connections/manager.js';

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
  frequency?: {
    gnomad_af?: number;
    population_breakdown?: Record<string, number>;
  };
  predictions?: {
    cadd_score?: number;
    sift_pred?: string;
    polyphen_pred?: string;
  };
}

const VARIANT_SEARCH_FILTERS = [
  'gene', 'hgvsp', 'hgvsc', 'rsid', 'protein_alias',
  'significance', 'max_frequency', 'min_cadd', 'consequence',
  'review_status', 'population', 'revel_min', 'gerp_min',
  'tumor_site', 'condition', 'impact', 'lof', 'has', 'missing', 'therapy'
] as const;

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
    `/variant/${id}?fields=gene,rsid,hgvs,significance,clinvar,gnomad,cadd`
  ) as MyVariantGetResponse;
  
  if (!response) {
    throw new Error(`Variant '${id}' not found`);
  }
  
  const variant: VariantResult = {
    id: response.rsid || id,
    gene: response.gene?.symbol,
    hgvs_p: response.hgvs?.p,
    hgvs_c: response.hgvs?.c,
  };
  
  if (response.clinvar) {
    variant.significance = response.clinvar.significance;
    variant.conditions = response.clinvar.conditions;
  }
  
  if (response.gnomad) {
    variant.frequency = {
      gnomad_af: response.gnomad.af,
    };
  }
  
  if (response.cadd) {
    variant.predictions = {
      cadd_score: response.cadd.score,
    };
  }
  
  return variant;
}

interface MyVariantSearchResponse {
  hits: Array<{
    _id: string;
    gene?: { symbol: string };
    rsid?: string;
    hgvs?: { p: string; c: string };
    clinical_significance?: string;
    clinvar?: { stars: number };
    gnomad?: { af: number };
  }>;
}

interface MyVariantGetResponse {
  _id: string;
  rsid?: string;
  gene?: { symbol: string };
  hgvs?: { p: string; c: string };
  clinvar?: {
    significance?: string;
    conditions?: string[];
  };
  gnomad?: {
    af?: number;
    populations?: Record<string, number>;
  };
  cadd?: {
    score?: number;
  };
  sift?: { pred: string };
  polyphen?: { pred: string };
}

function transformMyVariantHit(hit: MyVariantSearchResponse['hits'][0]): VariantSearchResult {
  return {
    id: hit.rsid || hit._id,
    gene: hit.gene?.symbol,
    hgvs_p: hit.hgvs?.p,
    hgvs_c: hit.hgvs?.c,
    significance: hit.clinical_significance,
    clinvar_stars: hit.clinvar?.stars,
    gnomad_af: hit.gnomad?.af,
  };
}
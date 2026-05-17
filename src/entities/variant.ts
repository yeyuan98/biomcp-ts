import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';

const SECTION_TIMEOUT_MS = 8000;

export interface VariantSearchOptions {
  query?: string;
  gene?: string;
  hgvsp?: string;
  hgvsc?: string;
  significance?: 'benign' | 'likely_benign' | 'pathogenic' | 'likely_pathogenic' | 'uncertain';
  consequence?: string;
  min_cadd?: number;
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
  gnomad_af?: number | null;
  gnomad_exome_af?: number | null;
  gnomad_genome_af?: number | null;
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
  'gene', 'hgvsp', 'significance', 'max_frequency', 'min_cadd', 'consequence',
] as const;

const VARIANT_GET_SECTIONS = ['core', 'frequency', 'predictions', 'clinical', 'alphagenome'] as const;

function rewriteVariantQuery(rawQuery: string): string {
  if (/^rs\d+$/i.test(rawQuery)) return `dbsnp.rsid:${rawQuery}`;
  // HGVS cDNA notation (e.g., NM_004333.4:c.1799T>A)
  const hgvsMatch = rawQuery.match(/^((?:NM_|NR_|ENST)\d+\.\d+):(c\..+)$/i);
  if (hgvsMatch) {
    return `snpeff.ann.feature_id:${hgvsMatch[1]} AND snpeff.ann.hgvs_c:"${hgvsMatch[2]}"`;
  }
  return rawQuery;
}

export async function variantSearch(
  options: VariantSearchOptions
): Promise<VariantSearchResult[]> {
  const { query, gene, hgvsp, hgvsc, significance, consequence, min_cadd, max_frequency, limit = 10, offset = 0 } = options;
  
  const conn = connectionManager.getConnection('myvariant');
  
  const queryParams = new URLSearchParams({
    size: String(limit),
    from: String(offset),
    fields: 'dbsnp,snpeff,clinvar,gnomad,cadd,dbnsfp',
  });
  
  const qParts: string[] = [];
  
  if (query) {
    qParts.push(rewriteVariantQuery(query));
  }
  
  if (gene) {
    qParts.push(`cadd.gene.genename:${gene}`);
  }
  
  if (hgvsp) {
    qParts.push(`dbnsfp.hgvsp:*${hgvsp}*`);
  }

  if (hgvsc) {
    qParts.push(`snpeff.ann.hgvs_c:"${hgvsc}"`);
  }
  
  if (significance) {
    const sigMap: Record<string, string> = {
      pathogenic: 'pathogenic',
      likely_pathogenic: 'likely pathogenic',
      benign: 'benign',
      likely_benign: 'likely benign',
      uncertain: 'uncertain significance',
    };
    qParts.push(`clinvar.rcv.clinical_significance:*${sigMap[significance] || significance}*`);
  }

  if (consequence) {
    const consequenceMap: Record<string, string> = {
      missense: 'missense_variant',
      synonymous: 'synonymous_variant',
      nonsense: 'stop_gained',
      frameshift: 'frameshift_variant',
      splice: 'splice_region_variant',
      intron: 'intron_variant',
      utr3: '3_prime_UTR_variant',
      utr5: '5_prime_UTR_variant',
    };
    const effectTerm = consequenceMap[consequence.toLowerCase()] || consequence;
    qParts.push(`snpeff.ann.effect:${effectTerm}`);
  }

  if (min_cadd !== undefined) {
    qParts.push(`cadd.phred:[${min_cadd} TO *]`);
  }
  
  if (max_frequency !== undefined) {
    qParts.push(`gnomad_af:[* TO ${max_frequency}]`);
  }
  
  if (qParts.length > 0) {
    queryParams.set('q', qParts.join(' AND '));
  }
  
  const response = await conn.request(`/query?${queryParams.toString()}`) as MyVariantSearchResponse;
  
  return (response.hits || []).map(transformMyVariantHit);
}

const HGVS_PATTERN = /^(NM_|NR_|ENST)\d+\.\d+:c\./;

async function resolveHgvsToGenomicId(hgvsId: string, conn: any): Promise<string> {
  const colonIdx = hgvsId.indexOf(':');
  const transcript = hgvsId.substring(0, colonIdx);
  const cNotation = hgvsId.substring(colonIdx + 1);

  const queryParams = new URLSearchParams({
    q: `snpeff.ann.feature_id:${transcript} AND snpeff.ann.hgvs_c:"${cNotation}"`,
    fields: '_id',
    size: '1',
  });

  const response = await conn.request(`/query?${queryParams.toString()}`) as { hits?: Array<{ _id: string }> };
  const genomicId = response.hits?.[0]?._id;
  if (!genomicId) {
    throw new Error(`Variant '${hgvsId}' not found (HGVS transcript ID could not be resolved to a genomic coordinate)`);
  }
  return genomicId;
}

export async function variantGet(
  id: string,
  sections?: string[]
): Promise<VariantResult> {
  const SECTION_ALIASES: Record<string, string> = {
    alphagenome_scores: 'alphagenome',
  };
  const normalizedSections = (sections || []).map(s => SECTION_ALIASES[s] || s);
  const sectionConfig = normalizedSections.length > 0 ? normalizedSections : ['core'];

  const conn = connectionManager.getConnection('myvariant');

  let resolvedId = id;
  if (HGVS_PATTERN.test(id)) {
    resolvedId = await resolveHgvsToGenomicId(id, conn);
  }

  let rawResponse = await conn.request(
    `/variant/${resolvedId}?fields=dbsnp,clinvar,gnomad_exome,gnomad_genome,cadd,dbnsfp,snpeff,cosmic`
  ) as MyVariantGetResponse | MyVariantGetResponse[];

  let allVariants: MyVariantGetResponse[] | undefined;
  if (Array.isArray(rawResponse)) {
    allVariants = rawResponse as MyVariantGetResponse[];
    const bestWithGnomad = allVariants
      .filter(v => (v as any).gnomad_exome || (v as any).gnomad_genome)
      .sort((a, b) => (b as any)._version - (a as any)._version)[0];
    rawResponse = bestWithGnomad || allVariants[0];
  }

  if (!rawResponse) {
    throw new Error(`Variant '${id}' not found`);
  }

  if ((rawResponse as any).error || (rawResponse as any).success === false) {
    throw new Error(`Variant '${id}' not found in MyVariant.info`);
  }

  const response = rawResponse as MyVariantGetResponse;
  
  const ann = asArray(response.snpeff?.ann)[0];
  const variant: VariantResult = {
    id: response.dbsnp?.rsid || response._id || id,
    gene: response.dbsnp?.gene?.symbol || ann?.genename || (response as any).dbnsfp?.gene?.genename,
    hgvs_p: ann?.hgvs_p,
    hgvs_c: ann?.hgvs_c,
    rsid: response.dbsnp?.rsid,
    cosmic_id: response.cosmic?.cosmic_id,
  };
  
  if (response.clinvar) {
    const rcv = asArray((response.clinvar as any).rcv);
    const mainRcv = rcv.find((r: any) => r.clinical_significance && r.clinical_significance !== 'not provided') || rcv[0];
    variant.significance = mainRcv?.clinical_significance;
    variant.conditions = extractAllClinvarConditions(rcv);
  }
  
  const sectionsToFetch = sectionConfig.includes('all')
    ? [...VARIANT_GET_SECTIONS]
    : sectionConfig.filter(s => VARIANT_GET_SECTIONS.includes(s as typeof VARIANT_GET_SECTIONS[number]));
  
  const sectionPromises = sectionsToFetch.map(section => {
    return fetchWithTimeout(async () => {
      switch (section) {
        case 'core':
          return { 
            section: 'core', 
            data: { 
              id: variant.id, 
              gene: variant.gene, 
              hgvs_p: variant.hgvs_p, 
              hgvs_c: variant.hgvs_c, 
              rsid: variant.rsid, 
              cosmic_id: variant.cosmic_id,
              significance: variant.significance,
              conditions: variant.conditions,
            } 
          };
        case 'frequency':
          return { section: 'frequency', data: await fetchFrequencySection(response, allVariants) };
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
          _error: sectionResult.error
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

async function fetchFrequencySection(
  variant: MyVariantGetResponse,
  allVariants?: MyVariantGetResponse[]
): Promise<FrequencySection | null> {
  const gnomadExome = (variant as any).gnomad_exome;
  const gnomadGenome = (variant as any).gnomad_genome;

  if (!gnomadExome && !gnomadGenome) {
    if (allVariants?.length) {
      for (const v of allVariants) {
        if ((v as any).gnomad_exome || (v as any).gnomad_genome) {
          return fetchFrequencySection(v);
        }
      }
    }
    return null;
  }

  const exomeAf = gnomadExome?.af?.af ?? null;
  const genomeAf = gnomadGenome?.af?.af ?? null;
  const populations: Record<string, number> = {};

  if (gnomadExome?.af) {
    for (const [key, val] of Object.entries(gnomadExome.af)) {
      if (key.startsWith('af_') && typeof val === 'number') {
        populations[key] = val;
      }
    }
  }
  if (gnomadGenome?.af) {
    for (const [key, val] of Object.entries(gnomadGenome.af)) {
      if (key.startsWith('af_') && typeof val === 'number') {
        populations[`genome_${key}`] = val;
      }
    }
  }

  return {
    gnomad_exome_af: exomeAf,
    gnomad_genome_af: genomeAf,
    gnomad_af: exomeAf ?? genomeAf,
    population_breakdown: populations,
  };
}

async function fetchPredictionsSection(variant: MyVariantGetResponse): Promise<PredictionsSection | null> {
  const result: PredictionsSection = {};
  
  const dbnsfp = (variant as any).dbnsfp;
  
  const cadd = variant.cadd || (dbnsfp?.cadd ? { score: dbnsfp.cadd.rawscore, phred: dbnsfp.cadd.phred } : undefined);
  const sift = variant.sift || (dbnsfp?.sift ? { score: dbnsfp.sift.score, pred: dbnsfp.sift.pred } : undefined);
  const polyphen = variant.polyphen || (dbnsfp?.polyphen2 ? { score: dbnsfp.polyphen2.score, pred: dbnsfp.polyphen2.pred } : undefined);
  const revel = variant.revel || dbnsfp?.revel;
  const vest = variant.vest || (dbnsfp?.vest3 ? { score: dbnsfp.vest3.score } : undefined);
  const gerp = variant.gerp || dbnsfp?.gerp;
  const phylop = variant.phylop || dbnsfp?.phylop;
  const phastcons = variant.phastcons || dbnsfp?.phastcons100way;
  const alphamissense = variant.alphamissense || dbnsfp?.alphamissense;
  const clinpred = variant.clinpred || dbnsfp?.clinpred;
  const metarnn = variant.metarnn || dbnsfp?.metarnn;
  
  if (cadd) {
    result.cadd_score = cadd.score;
    result.cadd_phred = cadd.phred;
  }
  
  if (sift) {
    result.sift_score = sift.score;
    result.sift_pred = sift.pred;
  }
  
  if (polyphen) {
    result.polyphen_score = polyphen.score;
    result.polyphen_pred = polyphen.pred;
  }
  
  if (revel) {
    result.revel_score = revel.score ?? revel;
  }
  
  if (vest) {
    result.vest_score = vest.score;
  }
  
  if (gerp) {
    result.conservation = {
      gerp: gerp.score ?? gerp,
    };
  }
  
  if (phylop) {
    result.conservation = result.conservation || {};
    result.conservation.phylop = phylop.score ?? phylop;
  }
  
  if (phastcons) {
    result.conservation = result.conservation || {};
    result.conservation.phastcons = phastcons.score ?? phastcons;
  }
  
  if (alphamissense) {
    result.other = { alphamissense: alphamissense.score ?? alphamissense };
  }
  
  if (clinpred) {
    result.other = result.other || {};
    result.other.clinpred = clinpred.score ?? clinpred;
  }
  
  if (metarnn) {
    result.other = result.other || {};
    result.other.metarnn = metarnn.score ?? metarnn;
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
    const rcv = asArray((variant.clinvar as any).rcv);
    const mainRcv = rcv.find((r: any) => r.clinical_significance && r.clinical_significance !== 'not provided') || rcv[0];
    const allConditions = extractAllClinvarConditions(rcv);
    result.clinvar = {
      id: (variant.clinvar as any).variant_id,
      significance: mainRcv?.clinical_significance,
      stars: mainRcv?.number_submitters,
      conditions: allConditions.length > 0 ? allConditions : undefined,
      review_status: mainRcv?.review_status,
      submitters: rcv.map((r: any) => `${r.number_submitters || 0} submitter(s)`),
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
    if (!process.env.ALPHAGENOME_API_KEY) {
      throw new Error('ALPHAGENOME_API_KEY environment variable is not set. AlphaGenome requires an API key. Set it in your environment to enable AlphaGenome variant scoring.');
    }

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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('ALPHAGENOME_API_KEY')) {
      const section: AlphaGenomeSection = { scorers: [] };
      throw new Error(msg);
    }
    return null;
  }
}

export async function fetchOncoKbAnnotation(gene: string, proteinChange: string): Promise<OncoKbAnnotation | null> {
  try {
    if (!process.env.ONCOKB_TOKEN) {
      throw new Error('ONCOKB_TOKEN environment variable is not set. OncoKB requires an API token. Set it in your environment to enable OncoKB variant annotations.');
    }

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
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('ONCOKB_TOKEN')) {
      throw error;
    }
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
  dbsnp?: { rsid: string; gene?: { symbol: string } };
    hgvs?: { p: string; c: string };
    clinical_significance?: string;
    clinvar?: { stars: number };
    gnomad?: { af: number };
  }>;
}

interface MyVariantGetResponse {
  _id: string;
  rsid?: string;
  dbsnp?: { rsid: string; gene?: { symbol: string } };
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
  gnomad_exome?: {
    af?: Record<string, any>;
  };
  gnomad_genome?: {
    af?: Record<string, any>;
  };
  cadd?: {
    score?: number;
    phred?: number;
  };
  dbnsfp?: {
    gene?: { genename?: string };
    cadd?: { rawscore?: number; phred?: number };
    sift?: { score?: number; pred?: string };
    polyphen2?: { score?: number; pred?: string };
    revel?: { score?: number };
    vest3?: { score?: number };
    gerp?: { score?: number };
    phylop?: { score?: number };
    phastcons100way?: { score?: number };
    alphamissense?: { score?: number };
    clinpred?: { score?: number };
    metarnn?: { score?: number };
    clinvar?: { clnsig?: string };
  };
  snpeff?: {
    ann?: Array<{
      genename?: string;
      hgvs_p?: string;
      hgvs_c?: string;
    }>;
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

function asArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function extractClinvarSignificance(clinvar: any): string | undefined {
  if (!clinvar) return undefined;
  const rcv = asArray(clinvar.rcv);
  const main = rcv.find((r: any) => r.clinical_significance && r.clinical_significance !== 'not provided') || rcv[0];
  return main?.clinical_significance;
}

function extractConditionNames(conditions: any): string[] {
  if (!conditions) return [];
  const items = Array.isArray(conditions) ? conditions : [conditions];
  return items.map((c: any) => c?.name).filter((n: any): n is string => !!n && n !== 'not provided');
}

function extractAllClinvarConditions(rcv: any[]): string[] {
  const names: string[] = [];
  for (const r of rcv) {
    names.push(...extractConditionNames(r.conditions));
  }
  return [...new Set(names)];
}

export function transformMyVariantHit(hit: any): VariantSearchResult {
  const ann = asArray(hit.snpeff?.ann)[0];
  return {
    id: hit.dbsnp?.rsid || hit._id,
    gene: hit.dbsnp?.gene?.symbol || ann?.genename || (hit as any).dbnsfp?.gene?.genename,
    hgvs_p: ann?.hgvs_p,
    hgvs_c: ann?.hgvs_c,
    significance: extractClinvarSignificance(hit.clinvar) || (hit as any).dbnsfp?.clinvar?.clnsig,
    clinvar_stars: hit.clinvar?.stars,
    gnomad_af: hit.gnomad?.af,
  };
}
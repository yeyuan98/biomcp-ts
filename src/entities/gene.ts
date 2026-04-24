import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';
import { transformMyGeneHit } from '../transform/gene.js';

const SECTION_TIMEOUT_MS = 8000;

export interface GeneSearchOptions {
  gene_type?: 'protein-coding' | 'ncRNA' | 'pseudo';
  chromosome?: string;
  limit?: number;
  offset?: number;
}

export interface GeneSearchResult {
  symbol: string;
  name: string;
  entrez_id?: number;
  genomic_coordinates?: {
    chromosome: string;
    start: number;
    end: number;
  };
  uniprot_id?: string;
  omim_id?: string;
}

export interface GeneGetOptions {
  sections?: string[];
}

export interface GeneResult {
  symbol: string;
  name: string;
  summary?: string;
  chromosome?: string;
  position?: string;
  sections?: Record<string, unknown>;
}

export async function geneSearch(
  query: string,
  options: GeneSearchOptions = {}
): Promise<GeneSearchResult[]> {
  const { gene_type, chromosome, limit = 10, offset = 0 } = options;
  
  const conn = connectionManager.getConnection('mygene');
  
  const queryParams = new URLSearchParams({
    q: query,
    species: 'human',
    fields: 'symbol,name,entrezgene,genomic_pos,uniprot,omim',
    size: String(limit),
    from: String(offset),
  });
  
  if (gene_type) {
    queryParams.set('type', gene_type);
  }
  
  if (chromosome) {
    queryParams.set('chr', chromosome);
  }
  
  const response = await conn.request(`/query?${queryParams.toString()}`) as MyGeneSearchResponse;
  
  return (response.hits || []).map(transformMyGeneHit);
}

export async function geneGet(
  symbol: string,
  sections?: string[]
): Promise<GeneResult> {
  const sectionConfig = sections || ['core'];
  
  const conn = connectionManager.getConnection('mygene');
  
  const queryParams = new URLSearchParams({
    q: `symbol:"${symbol}"`,
    species: 'human',
    fields: 'symbol,name,summary,genomic_pos,uniprot,omim,interactor',
    size: '1',
  });
  
  const response = await conn.request(`/query?${queryParams.toString()}`) as MyGeneGetResponse;
  
  if (!response.hits || response.hits.length === 0) {
    throw new Error(`Gene '${symbol}' not found. Try gene_search to find valid gene symbols.`);
  }
  
  const gene = response.hits[0];
  const result: GeneResult = {
    symbol: gene.symbol,
    name: gene.name,
    summary: gene.summary,
  };
  
  if (gene.genomic_pos) {
    const pos = Array.isArray(gene.genomic_pos) ? gene.genomic_pos[0] : gene.genomic_pos;
    if (pos && pos.chr) {
      result.chromosome = pos.chr;
      result.position = `${pos.start}-${pos.end}`;
    }
  }
  
  const sectionsToFetch = sectionConfig.includes('all') 
    ? ['pathways', 'protein', 'ontology', 'go', 'interactions', 'civic', 'expression', 'hpa', 'druggability', 'clingen', 'constraint', 'disgenet', 'funding']
    : sectionConfig.filter(s => s !== 'core');

  if (sectionsToFetch.length > 0) {
    const sectionPromises = sectionsToFetch.map(section => {
      return fetchWithTimeout(async () => {
        switch (section) {
          case 'pathways': return { section: 'pathways', data: await fetchPathways(symbol) };
          case 'protein': return { section: 'protein', data: await fetchProtein(symbol) };
          case 'ontology': return { section: 'ontology', data: await fetchOntology(symbol) };
          case 'go': return { section: 'go', data: await fetchGo(symbol) };
          case 'interactions': return { section: 'interactions', data: await fetchInteractions(symbol) };
          case 'civic': return { section: 'civic', data: await fetchCivic(symbol) };
          case 'expression': return { section: 'expression', data: await fetchExpression(symbol) };
          case 'hpa': return { section: 'hpa', data: await fetchHpa(symbol) };
          case 'druggability': return { section: 'druggability', data: await fetchDruggability(symbol) };
          case 'clingen': return { section: 'clingen', data: await fetchClingen(symbol) };
          case 'constraint': return { section: 'constraint', data: await fetchConstraint(symbol) };
          case 'disgenet': return { section: 'disgenet', data: await fetchDisgenet(symbol) };
          case 'funding': return { section: 'funding', data: await fetchFunding(symbol) };
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

async function fetchPathways(geneSymbol: string): Promise<Array<{ id: string; name: string; source: string }>> {
  try {
    const conn = connectionManager.getConnection('reactome');
    
    const response = await conn.request(
      `/search/query?query=${encodeURIComponent(geneSymbol)}&species=Homo sapiens&limit=10`
    ) as ReactomeResponse;
    
    return (response.results || []).map((r) => ({
      id: r.stId,
      name: r.name,
      source: 'reactome',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchPathways] Error:', error);
    return [{ _error: `Pathway lookup failed (source: reactome): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

async function fetchProtein(geneSymbol: string): Promise<{ accession?: string; name?: string }> {
  try {
    const conn = connectionManager.getConnection('uniprot');
    
    const response = await conn.request(
      `/uniprotkb/stream?query=gene:${geneSymbol}+AND+organism_id:9606&format=json&fields=accession,protein_name&size=1`
    ) as UniProtSearchResponse;
    
    if (response.results && response.results.length > 0) {
      const r = response.results[0];
      return {
        accession: r.primaryAccession,
        name: r.proteinDescription?.recommendedName?.fullName?.value,
      };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchProtein] Error:', error);
    return { _error: `Protein lookup failed (source: uniprot): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
  return {};
}

async function fetchOntology(geneSymbol: string): Promise<{ go_enrichment?: Array<{ id: string; term: string; p_value?: number }> }> {
  try {
    const conn = connectionManager.getConnection('mygene');
    
    const response = await conn.request(
      `/query?q=symbol:${encodeURIComponent(geneSymbol)}&species=human&fields=go&size=1`
    ) as MyGeneGOResponse;
    
    const goData = response.hits?.[0]?.go;
    if (!goData) return { go_enrichment: [] };
    
    const terms: Array<{ id: string; term: string; aspect: string }> = [];
    for (const category of ['BP', 'MF', 'CC'] as const) {
      const items = (goData as Record<string, Array<{ id: string; term: string; gocategory?: string }>>)[category] || [];
      for (const item of items) {
        terms.push({ id: item.id, term: item.term, aspect: category });
      }
    }
    
    return { go_enrichment: terms.slice(0, 20).map(t => ({ id: t.id, term: t.term })) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { _error: `Ontology lookup failed (source: mygene): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

async function fetchGo(geneSymbol: string): Promise<Array<{ id: string; term: string; aspect: string }>> {
  try {
    const conn = connectionManager.getConnection('mygene');
    
    const response = await conn.request(
      `/query?q=symbol:${encodeURIComponent(geneSymbol)}&species=human&fields=go&size=1`
    ) as MyGeneGOResponse;
    
    const goData = response.hits?.[0]?.go;
    if (!goData) return [];
    
    const terms: Array<{ id: string; term: string; aspect: string }> = [];
    for (const category of ['BP', 'MF', 'CC'] as const) {
      const items = (goData as Record<string, Array<{ id: string; term: string; gocategory?: string }>>)[category] || [];
      for (const item of items) {
        terms.push({ id: item.id, term: item.term, aspect: category });
      }
    }
    
    return terms.slice(0, 50);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `GO term lookup failed (source: mygene): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

async function fetchInteractions(geneSymbol: string): Promise<Array<{ symbol: string; score: number; source: string }>> {
  try {
    const conn = connectionManager.getConnection('string');
    
    const response = await conn.request(
      `/json/interaction_partners?identifiers=${encodeURIComponent(geneSymbol)}&species=9606&limit=20`
    ) as StringInteractionsResponse;
    
    return (Array.isArray(response) ? response : []).slice(0, 20).map(r => ({
      symbol: r.preferredNameB || r.preferredName || '',
      score: r.score || 0,
      source: 'string',
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Interaction lookup failed (source: string-db): ${msg}. The data source may be temporarily unavailable.` } as any];
  }
}

async function fetchCivic(geneSymbol: string): Promise<{ variants?: Array<{ name: string; clinical_significance?: string }> }> {
  try {
    const conn = connectionManager.getConnection('civic');
    
    const query = `query($symbol: String!) { genes(symbol: $symbol) { name variants { name clinicalSignificance } } }`;
    
    const response = await conn.request(query, { symbol: geneSymbol }) as unknown as { data?: { genes: Array<{ name: string; variants: Array<{ name: string; clinicalSignificance?: string }> }> } };
    const parsed = JSON.parse(JSON.stringify(response));
    
    const variants = (parsed.data?.genes || []).slice(0, 20).map((g: { name: string; variants: Array<{ name: string; clinicalSignificance?: string }> }) => ({
      name: g.name,
      clinical_significance: g.variants?.[0]?.clinicalSignificance,
    }));
    
    return { variants };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchCivic] Error:', error);
    return { _error: `CIViC variant lookup failed (source: civic): ${msg}. The data source may be temporarily unavailable or the gene may not have clinical variants.` } as any;
  }
}

async function fetchExpression(geneSymbol: string): Promise<{ tissues?: Array<{ tissue: string; tpm: number }> }> {
  try {
    const conn = connectionManager.getConnection('gtex');
    
    const response = await conn.request(
      `/v1/gene/${encodeURIComponent(geneSymbol)}?format=json`
    ) as GTExResponse;
    
    const tissues = (response.data || []).slice(0, 20).map((r: { tissue: string; tpm: number }) => ({
      tissue: r.tissue,
      tpm: r.tpm,
    }));
    
    return { tissues };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchExpression] Error:', error);
    return { _error: `Expression lookup failed (source: gtex): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

async function fetchHpa(geneSymbol: string): Promise<{ subcellular?: Array<{ location: string; confidence: string }> }> {
  try {
    const conn = connectionManager.getConnection('hpa');
    
    const response = await conn.request(
      `/search?query=${encodeURIComponent(geneSymbol)}&format=json`
    ) as HPAResponse;
    
    const subcellular = (response.results || []).slice(0, 10).map(r => ({
      location: r.subcellularLocation || '',
      confidence: r['enhanced-reliability'] ? 'enhanced' : 'approved',
    }));
    
    return { subcellular };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchHpa] Error:', error);
    return { _error: `Subcellular location lookup failed (source: hpa): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

async function fetchDruggability(geneSymbol: string): Promise<{ dgidb?: Array<{ drug_name: string; sources: string[] }>; opentargets?: Array<{ id: string; name: string; tractability: number }> }> {
  try {
    const dgidbConn = connectionManager.getConnection('dgidb');
    
    const dgidbQuery = `query($symbol: String!) { drugs(genes: $symbol) { drug sources } }`;
    
    const rawDgidb = await dgidbConn.request(dgidbQuery, { symbol: geneSymbol }) as unknown as { data?: { drugs: Array<{ drug: string; sources: string[] }> } };
    const dgidbResponse = JSON.parse(JSON.stringify(rawDgidb));
    const dgidbData = (dgidbResponse.data?.drugs || []).slice(0, 20).map((d: { drug: string; sources: string[] }) => ({
      drug_name: d.drug,
      sources: d.sources,
    }));
    
    try {
      const otConn = connectionManager.getConnection('opentargets');
      
      const otQuery = `query($symbol: String!) { target(ensembl: $symbol) { id approvedName tractability { value } } }`;
      
      const rawOt = await otConn.request(otQuery, { symbol: geneSymbol }) as unknown as { data?: Array<{ id: string; approvedName?: string; tractability?: { value: number } }> };
      const otResponse = JSON.parse(JSON.stringify(rawOt));
      const opentargetsData = (otResponse.data || []).slice(0, 20).map((t: { id: string; approvedName?: string; tractability?: { value: number } }) => ({
        id: t.id,
        name: t.approvedName || '',
        tractability: t.tractability?.value || 0,
      }));
      
      return { dgidb: dgidbData, opentargets: opentargetsData };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[fetchDruggability/opentargets] Error:', error);
      return { dgidb: dgidbData, _error: `OpenTargets tractability lookup failed: ${msg}. DGIdb drug data was retrieved successfully.` } as any;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchDruggability/dgidb] Error:', error);
    return { _error: `Druggability lookup failed (source: dgidb): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

async function fetchClingen(geneSymbol: string): Promise<{ dosagem?: Array<{ haploinsufficiency: string; triplosensitivity: string }> }> {
  try {
    const conn = connectionManager.getConnection('clingen');
    
    const response = await conn.request(
      `/gene/${encodeURIComponent(geneSymbol)}?format=json`
    ) as ClingenResponse;
    
    return {
      dosagem: [{
        haploinsufficiency: response.haploinsufficiencyScore || 'unknown',
        triplosensitivity: response.triplosensitivityScore || 'unknown',
      }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchClingen] Error:', error);
    return { _error: `ClinGen dosage sensitivity lookup failed (source: clingen): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

async function fetchConstraint(geneSymbol: string): Promise<{ lof?: { oe_score: number; mis_bad_loe: number }; syn?: { oe_score: number } }> {
  try {
    const conn = connectionManager.getConnection('gnomad');
    
    const query = `query($symbol: String!) { gene(gene_symbol: $symbol) { lof { oe_score mis_bad_loeoe } synonyms { oe_score } } }`;
    
    const rawResponse = await conn.request(query, { symbol: geneSymbol }) as unknown as { data?: { gene?: { lof?: { oe_score?: number; mis_bad_loeoe?: number }; synonyms?: { oe_score?: number } } } };
    const response = JSON.parse(JSON.stringify(rawResponse));
    const data = response.data?.gene;
    
    return {
      lof: {
        oe_score: data?.lof?.oe_score || 0,
        mis_bad_loe: data?.lof?.mis_bad_loeoe || 0,
      },
      syn: {
        oe_score: data?.synonyms?.oe_score || 0,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchConstraint] Error:', error);
    return { _error: `Constraint score lookup failed (source: gnomad): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

async function fetchDisgenet(geneSymbol: string): Promise<{ associations?: Array<{ disease_name: string; score: number; source: string }> }> {
  try {
    const conn = connectionManager.getConnection('disgenet');
    
    const response = await conn.request(
      `/api/v1/gene/${encodeURIComponent(geneSymbol)}?format=json`
    ) as DisgenetResponse;
    
    const associations = (response.results || []).slice(0, 20).map(r => ({
      disease_name: r.diseaseName,
      score: r.score,
      source: r.diseaseDatasource,
    }));
    
    return { associations };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchDisgenet] Error:', error);
    return { _error: `Disease association lookup failed (source: disgenet): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

async function fetchFunding(geneSymbol: string): Promise<{ grants?: Array<{ nih_id: string; title: string; agency: string; amount: number }> }> {
  try {
    const conn = connectionManager.getConnection('nih_reporter');
    
    const response = await conn.request(
      `/projects/search?criteria={"genes":[${encodeURIComponent(geneSymbol)}]}&format=json`
    ) as NIHReporterResponse;
    
    const grants = (response.results || []).slice(0, 20).map(r => ({
      nih_id: r.projectNumber,
      title: r.projectTitle,
      agency: r.agency,
      amount: r.totalCostAmount,
    }));
    
    return { grants };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[fetchFunding] Error:', error);
    return { _error: `Funding lookup failed (source: nih-reporter): ${msg}. The data source may be temporarily unavailable.` } as any;
  }
}

interface MyGeneSearchResponse {
  hits: Array<{
    symbol: string;
    name: string;
    entrezgene?: number;
    genomic_pos?: Array<{ chr: string; start: number; end: number }>;
    uniprot?: string[];
    omim?: number[];
  }>;
}

interface MyGeneGetResponse {
  hits: Array<{
    symbol: string;
    name: string;
    summary?: string;
    genomic_pos?: Array<{ chr: string; start: number; end: number }>;
    uniprot?: Array<{ SwissProt: string }>;
    omim?: number[];
    interactor?: Array<{ interaction_type: string }>;
  }>;
}

interface ReactomeResponse {
  results: Array<{ stId: string; name: string }>;
}

interface UniProtSearchResponse {
  results: Array<{
    primaryAccession: string;
    proteinDescription?: {
      recommendedName?: { fullName?: { value: string } };
    };
  }>;
}

interface QuickGOEnrichResponse {
  results: Array<{
    goId: string;
    goName: string;
    qValue: number;
  }>;
}

interface QuickGOTermsResponse {
  results: Array<{
    goId: string;
    goName: string;
    aspect: string;
  }>;
}

interface MyGeneGOResponse {
  hits?: Array<{
    go?: Record<string, Array<{ id: string; term: string; gocategory?: string }>>;
  }>;
}

interface StringInteractionsResponse extends Array<{
  preferredNameB?: string;
  preferredName?: string;
  score?: number;
}> {}

interface CivicResponse {
  data?: {
    genes: Array<{
      name: string;
      variants: Array<{
        name: string;
        clinicalSignificance?: string;
      }>;
    }>;
  };
}

interface GTExResponse {
  data?: Array<{
    tissue: string;
    tpm: number;
  }>;
}

interface HPAResponse {
  results?: Array<{
    subcellularLocation?: string;
    'enhanced-reliability'?: boolean;
  }>;
}

interface DGIdbResponse {
  data?: {
    drugs: Array<{
      drug: string;
      sources: string[];
    }>;
  };
}

interface OpenTargetsResponse {
  data?: Array<{
    id: string;
    approvedName: string;
    tractability?: {
      value: number;
    };
  }>;
}

interface ClingenResponse {
  haploinsufficiencyScore?: string;
  triplosensitivityScore?: string;
}

interface GnomadConstraintResponse {
  data?: {
    lof?: {
      oe_score: number;
      mis_bad_loeoe: number;
    };
    synonyms?: {
      oe_score: number;
    };
  };
}

interface DisgenetResponse {
  results: Array<{
    diseaseName: string;
    score: number;
    diseaseDatasource: string;
  }>;
}

interface NIHReporterResponse {
  results: Array<{
    projectNumber: string;
    projectTitle: string;
    agency: string;
    totalCostAmount: number;
  }>;
}

export function transformMyGeneResponse(data: MyGeneGetResponse['hits'][0]): GeneResult {
  return {
    symbol: data.symbol,
    name: data.name,
    summary: data.summary,
  };
}
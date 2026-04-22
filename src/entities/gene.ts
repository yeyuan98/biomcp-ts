import { connectionManager } from '../connections/manager.js';

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
    const pos = gene.genomic_pos[0];
    result.chromosome = pos.chr;
    result.position = `${pos.start}-${pos.end}`;
  }
  
  if (sectionConfig.includes('all') || sectionConfig.includes('pathways')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>).pathways = await fetchPathways(symbol);
  }
  
  if (sectionConfig.includes('all') || sectionConfig.includes('protein')) {
    result.sections = result.sections || {};
    (result.sections as Record<string, unknown>).protein = await fetchProtein(symbol);
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
  } catch {
    return [];
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
  } catch {
    // Fall through
  }
  return {};
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

function transformMyGeneHit(hit: MyGeneSearchResponse['hits'][0]): GeneSearchResult {
  return {
    symbol: hit.symbol,
    name: hit.name,
    entrez_id: hit.entrezgene,
    genomic_coordinates: hit.genomic_pos?.[0] ? {
      chromosome: hit.genomic_pos[0].chr,
      start: hit.genomic_pos[0].start,
      end: hit.genomic_pos[0].end,
    } : undefined,
    uniprot_id: hit.uniprot?.[0],
    omim_id: hit.omim?.[0] ? String(hit.omim[0]) : undefined,
  };
}

export function transformMyGeneResponse(data: MyGeneGetResponse['hits'][0]): GeneResult {
  return {
    symbol: data.symbol,
    name: data.name,
    summary: data.summary,
  };
}
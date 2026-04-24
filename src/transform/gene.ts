import type { GeneSearchResult, GeneResult } from '../entities/gene.js';

interface MyGeneHit {
  symbol: string;
  name: string;
  entrezgene?: number;
  genomic_pos?: Array<{ chr: string; start: number; end: number }>;
  uniprot?: string[];
  omim?: number[];
}

interface MyGeneRecord {
  symbol: string;
  name: string;
  summary?: string;
  genomic_pos?: Array<{ chr: string; start: number; end: number }>;
  uniprot?: Array<{ SwissProt: string }>;
  omim?: number[];
}

export function transformMyGeneHit(hit: MyGeneHit): GeneSearchResult {
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

export function transformMyGeneResponse(data: MyGeneRecord): GeneResult {
  return {
    symbol: data.symbol,
    name: data.name,
    summary: data.summary,
  };
}

export function normalizeAliases(aliases?: string[]): string[] {
  if (!aliases) return [];
  return aliases.filter(a => a && a.length > 0);
}
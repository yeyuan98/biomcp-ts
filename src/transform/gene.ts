import type { GeneSearchResult, GeneResult } from '../entities/gene.js';

interface MyGeneHit {
  symbol: string;
  name: string;
  entrezgene?: number;
  // mygene returns a plain object for single genome mappings (live: TP53 →
  // genomic_pos:{"chr":"17",...}) and an array only for multi-mappings; the
  // `uniprot` field likewise arrives as {SwissProt:"..."} or a string array.
  genomic_pos?: { chr: string; start: number; end: number } | Array<{ chr: string; start: number; end: number }>;
  uniprot?: string[] | { SwissProt: string };
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

/**
 * Transform a mygene search hit. `preferChromosome` (the normalized
 * chromosome a chromosome-filtered search used) only affects multi-mapping
 * hits: mygene returns an unordered genomic_pos array for genes mapping to
 * several loci (e.g. PAR genes with both X and Y positions), and the row's
 * coordinates should reflect the chromosome the user filtered by.
 */
export function transformMyGeneHit(hit: MyGeneHit, preferChromosome?: string): GeneSearchResult {
  // Tolerant single-value accessors (same pattern as geneGet): mygene emits
  // a plain object when there is one mapping and an array when there are
  // several — reading `[0]` unconditionally dropped every object-shaped
  // genomic_pos/uniprot value.
  let pos: { chr: string; start: number; end: number } | undefined;
  if (Array.isArray(hit.genomic_pos)) {
    pos = (preferChromosome && hit.genomic_pos.find(p => p.chr === preferChromosome)) || hit.genomic_pos[0];
  } else {
    pos = hit.genomic_pos;
  }
  const uniprot = Array.isArray(hit.uniprot) ? hit.uniprot[0] : hit.uniprot?.SwissProt;
  return {
    symbol: hit.symbol,
    name: hit.name,
    entrez_id: hit.entrezgene,
    genomic_coordinates: pos ? {
      chromosome: pos.chr,
      start: pos.start,
      end: pos.end,
    } : undefined,
    uniprot_id: uniprot,
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
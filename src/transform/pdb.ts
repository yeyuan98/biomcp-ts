import type { PdbEntrySummary } from '../entities/pdb.js';

interface RcsbEntryResponse {
  struct?: {
    title?: string;
  };
  exptl?: Array<{ method?: string }>;
  refine?: Array<{ ls_d_res_high?: number; ls_d_res_low?: number }>;
  rcsb_entry_info?: {
    resolution_combined?: Array<[number, number]>;
    molecular_weight?: number;
    polymer_entity_count?: number;
    polymer_composition?: string;
    deposited_model_count?: number;
  };
  rcsb_accession_info?: {
    initial_release_date?: string;
    deposit_date?: string;
    revision_date?: string;
  };
  rcsb_entry_container_identifiers?: {
    entry_id?: string;
    polymer_entity_ids?: string[];
    non_polymer_entity_ids?: string[];
    assembly_ids?: string[];
  };
  rcsb_primary_citation?: {
    title?: string;
    pdbx_database_id_DOI?: string;
    pdbx_database_id_PubMed?: string;
    authors?: Array<{ name?: string }>;
    journal_abbrev?: string;
    year?: number;
  };
  audit_author?: Array<{ name?: string }>;
  rcsb_entity_source_organism?: Array<{
    ncbi_scientific_name?: string;
    common_name?: string;
    taxonomy_lineage?: Array<{ name?: string }>;
  }>;
  symmetry?: {
    space_group_name_H_M?: string;
  };
  cell?: {
    length_a?: number;
    length_b?: number;
    length_c?: number;
    angle_alpha?: number;
    angle_beta?: number;
    angle_gamma?: number;
  };
}

export function transformPdbEntry(pdbId: string, raw: RcsbEntryResponse): PdbEntrySummary {
  const methods = raw.exptl
    ?.map(e => e.method)
    .filter((m): m is string => !!m) ?? [];

  const uniqueMethods = [...new Set(methods)];

  const resolution = raw.refine?.[0]?.ls_d_res_high
    ?? raw.rcsb_entry_info?.resolution_combined?.[0]?.[0];

  const organism = raw.rcsb_entity_source_organism?.[0]?.ncbi_scientific_name
    ?? raw.rcsb_entity_source_organism?.[0]?.common_name;

  const citation = raw.rcsb_primary_citation;

  return {
    pdb_id: pdbId,
    title: raw.struct?.title ?? '',
    experimental_method: uniqueMethods.length > 0 ? uniqueMethods.join(', ') : undefined,
    resolution,
    molecular_weight: raw.rcsb_entry_info?.molecular_weight,
    polymer_count: raw.rcsb_entry_info?.polymer_entity_count,
    polymer_composition: raw.rcsb_entry_info?.polymer_composition,
    deposition_date: raw.rcsb_accession_info?.deposit_date,
    release_date: raw.rcsb_accession_info?.initial_release_date,
    organism,
    doi: citation?.pdbx_database_id_DOI,
    pmid: citation?.pdbx_database_id_PubMed,
    authors: raw.audit_author
      ?.map(a => a.name)
      .filter((n): n is string => !!n),
    space_group: raw.symmetry?.space_group_name_H_M,
    unit_cell: raw.cell ? {
      a: raw.cell.length_a,
      b: raw.cell.length_b,
      c: raw.cell.length_c,
      alpha: raw.cell.angle_alpha,
      beta: raw.cell.angle_beta,
      gamma: raw.cell.angle_gamma,
    } : undefined,
    container_ids: raw.rcsb_entry_container_identifiers ? {
      polymer_entity_ids: raw.rcsb_entry_container_identifiers.polymer_entity_ids ?? [],
      non_polymer_entity_ids: raw.rcsb_entry_container_identifiers.non_polymer_entity_ids ?? [],
      assembly_ids: raw.rcsb_entry_container_identifiers.assembly_ids ?? [],
    } : undefined,
  };
}

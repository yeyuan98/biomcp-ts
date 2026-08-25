import { connectionManager } from '../connections/manager.js';
import { RestConnection } from '../connections/rest.js';

// EXCLUDED ENDPOINTS — constant failures during 2026-08 empirical probing
// (plan §2.2); do not add these without re-validating upstream stability:
//   - GET /xrefs/*      — hung >45s across 3 attempts, then 503; excluded,
//                         so cross-reference data is NOT available from this
//                         module (lookup expand=1 does not carry xref fields).
//   - GET /phenotype/*  — hung >45s across 2 attempts; phenotype associations
//                         are covered by the Monarch-backed disease tools.
//   - feature=regulatory on /overlap — deprecated upstream, unreliable.
// General transient 500/503s on healthy endpoints are handled by the
// connection-level retry (see registry entry `ensembl`), not exclusion.

const DEFAULT_SPECIES = 'human';
const DEFAULT_HOMOLOGY_LIMIT = 20;
const MAX_HOMOLOGY_LIMIT = 100;
const DEFAULT_CONSEQUENCE_LIMIT = 10;
const MAX_CONSEQUENCE_LIMIT = 50;
const DEFAULT_REGION_LIMIT = 50;
const REGION_ALLOWED_FEATURES = ['gene', 'transcript', 'variation'] as const;
// NB: upstream rejects spans > 5,000,000 bp ("greater than the maximum
// allowed length of 5000000") — verified live; keep the client cap in sync.
const REGION_MAX_SPAN_BP = 5_000_000;

const ENSEMBL_GENE_ID_RE = /^ENS[A-Z]{0,4}G\d+(\.\d+)?$/i;
// NB: /lookup/id and /homology/id accept BARE stable IDs only — a versioned
// ENSG….\d+ returns HTTP 400 upstream ("ID 'ENSG….16' not found"). Versions
// are scrubbed before routing (mirrors gtex.ts's stale-version handling).
const VERSIONED_GENE_ID_RE = /^ENS[A-Z]{0,4}G\d+\.\d+$/i;
const RSID_RE = /^rs\d+$/i;
const HGVS_MINIMAL_RE = /^[^:]+:[cgnprm]\.\S+/i;

const IMPACT_RANK: Record<string, number> = {
  HIGH: 3,
  MODERATE: 2,
  LOW: 1,
  MODIFIER: 0,
};

export interface EnsemblTranscriptInfo {
  id: string;
  version?: number;
  biotype?: string;
  is_canonical: boolean;
  display_name?: string;
  translation_id: string | null;
  exon_count?: number;
}

export interface EnsemblGeneInfo {
  input: string;
  species: string;
  id: string;
  symbol: string;
  biotype: string;
  version?: number;
  assembly: string;
  chromosome: string;
  start: number | null;
  end: number | null;
  strand: number | null;
  canonical_transcript: string | null;
  transcripts?: EnsemblTranscriptInfo[];
}

export interface EnsemblHomologyTarget {
  id: string;
  species: string;
  taxon_id: number | null;
  protein_id: string | null;
  perc_id: number | null;
  perc_pos: number | null;
}

export interface EnsemblHomologyEntry {
  type: string;
  taxonomy_level: string | null;
  source_id: string;
  source_species: string;
  target: EnsemblHomologyTarget;
}

export interface EnsemblHomologyResult {
  input: string;
  species: string;
  type: 'orthologues' | 'paralogues';
  total: number;
  returned: number;
  truncated: boolean;
  homologies: EnsemblHomologyEntry[];
}

export interface EnsemblConsequenceEffect {
  transcript_id: string;
  gene_id: string | null;
  gene_symbol: string | null;
  biotype: string | null;
  consequence_terms: string[];
  impact: string | null;
  codons: string | null;
  amino_acids: string | null;
  protein_start: number | null;
  protein_end: number | null;
  sift_prediction: string | null;
  sift_score: number | null;
  polyphen_prediction: string | null;
  polyphen_score: number | null;
}

export interface EnsemblColocatedVariant {
  id: string | null;
  source: string | null;
  clin_sig: string[];
  frequencies: Record<string, unknown> | null;
}

export interface EnsemblConsequenceResult {
  input: string;
  species: string;
  most_severe_consequence: string | null;
  allele_string: string | null;
  effects_total: number;
  effects_returned: number;
  consequences: EnsemblConsequenceEffect[];
  colocated_variants: EnsemblColocatedVariant[];
}

export interface EnsemblRegionFeature {
  type: string;
  id: string;
  symbol: string | null;
  biotype: string | null;
  chromosome: string;
  start: number | null;
  end: number | null;
  strand: number | null;
  alleles: string[] | null;
  consequence_types: string[];
  clinical_significance: string[];
  source: string | null;
}

export interface EnsemblRegionResult {
  region: string;
  species: string;
  features_requested: string[];
  total: number;
  returned: number;
  truncated: boolean;
  features: EnsemblRegionFeature[];
}

interface RawGene {
  id?: string;
  display_name?: string;
  biotype?: string;
  version?: number;
  assembly_name?: string;
  seq_region_name?: string;
  start?: number;
  end?: number;
  strand?: number;
  canonical_transcript?: string;
  Transcript?: RawTranscript[];
}

interface RawTranscript {
  id?: string;
  version?: number;
  biotype?: string;
  is_canonical?: number | boolean;
  display_name?: string;
  Translation?: { id?: string };
  Exon?: unknown[];
}

interface RawHomology {
  // Live responses use {"data":[{"id","homologies":[…]}]}; older docs show
  // {"data":{"homologies":[…]}} — both accepted defensively.
  data?: Array<{ id?: string; homologies?: RawHomologyEntry[] }> | { homologies?: RawHomologyEntry[] };
  homologies?: RawHomologyEntry[];
}

interface RawHomologyEntry {
  type?: string;
  method_link_type?: string;
  taxonomy_level?: string;
  source?: { id?: string; species?: string };
  target?: {
    id?: string;
    species?: string;
    taxon_id?: number;
    protein_id?: string;
    perc_id?: number | null;
    perc_pos?: number | null;
  };
}

interface RawVepResult {
  most_severe_consequence?: string;
  allele_string?: string;
  transcript_consequences?: Array<Record<string, unknown>>;
  colocated_variants?: Array<Record<string, unknown>>;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** True when the input looks like an Ensembl gene stable ID (ENSG…, ENSMUSG…). */
export function isEnsemblGeneId(input: string): boolean {
  return ENSEMBL_GENE_ID_RE.test(input.trim());
}

/** Strip a `.version` suffix — upstream ID endpoints reject versioned forms. */
function bareGeneId(input: string): string {
  return VERSIONED_GENE_ID_RE.test(input.trim()) ? input.trim().split('.')[0] : input.trim();
}

function ensemblConn() {
  return connectionManager.getConnection('ensembl');
}

async function fetchGene(path: string): Promise<RawGene> {
  return (await ensemblConn().request(path)) as RawGene;
}

function mapTranscript(t: RawTranscript): EnsemblTranscriptInfo {
  return {
    id: t.id ?? '',
    version: t.version,
    biotype: optStr(t.biotype) ?? undefined,
    is_canonical: t.is_canonical === 1 || t.is_canonical === true,
    display_name: optStr(t.display_name) ?? undefined,
    translation_id: optStr(t.Translation?.id),
    exon_count: Array.isArray(t.Exon) ? t.Exon.length : undefined,
  };
}

function mapGene(input: string, species: string, raw: RawGene, expand: boolean): EnsemblGeneInfo {
  const info: EnsemblGeneInfo = {
    input,
    species,
    id: raw.id ?? '',
    symbol: raw.display_name ?? '',
    biotype: raw.biotype ?? '',
    version: raw.version,
    assembly: raw.assembly_name ?? '',
    chromosome: raw.seq_region_name ?? '',
    start: num(raw.start),
    end: num(raw.end),
    strand: num(raw.strand),
    canonical_transcript: optStr(raw.canonical_transcript),
  };
  if (expand) {
    info.transcripts = (Array.isArray(raw.Transcript) ? raw.Transcript : []).map(mapTranscript);
  }
  return info;
}

/** Resolve a gene symbol or Ensembl stable ID to core Ensembl metadata.
 *  Exported for reuse by future cross-module resolvers. */
export async function resolveEnsemblGene(
  geneIdentifier: string,
  species: string = DEFAULT_SPECIES
): Promise<EnsemblGeneInfo> {
  const trimmed = geneIdentifier.trim();
  if (!trimmed) throw new Error('gene identifier is required');
  if (/^ENS[A-Z]{0,4}[TP]\d+/i.test(trimmed)) {
    throw new Error(
      `'${trimmed}' is an Ensembl transcript/protein ID — resolve genes only (ENSG… or symbol)`
    );
  }
  if (isEnsemblGeneId(trimmed)) {
    const id = bareGeneId(trimmed);
    return mapGene(trimmed, species, await fetchGene(`/lookup/id/${encodeURIComponent(id)}`), false);
  }
  const encoded = encodeURIComponent(trimmed);
  return mapGene(trimmed, species, await fetchGene(`/lookup/symbol/${encodeURIComponent(species)}/${encoded}`), false);
}

export async function ensemblLookup(
  geneOrId: string,
  options: { species?: string; expand?: boolean } = {}
): Promise<EnsemblGeneInfo> {
  const species = options.species?.trim() || DEFAULT_SPECIES;
  const expand = options.expand === true;
  const suffix = expand ? '?expand=1' : '';

  const trimmed = geneOrId.trim();
  if (!trimmed) throw new Error('gene_or_id is required');
  if (/^ENS[A-Z]{0,4}[TP]\d+/i.test(trimmed)) {
    throw new Error(
      `'${trimmed}' is an Ensembl transcript/protein ID — provide a gene (ENSG…/symbol); transcript-level tools are deferred`
    );
  }

  if (isEnsemblGeneId(trimmed)) {
    return mapGene(trimmed, species, await fetchGene(`/lookup/id/${encodeURIComponent(bareGeneId(trimmed))}${suffix}`), expand);
  }
  return mapGene(
    trimmed,
    species,
    await fetchGene(`/lookup/symbol/${encodeURIComponent(species)}/${encodeURIComponent(trimmed)}${suffix}`),
    expand
  );
}

export async function ensemblHomology(
  gene: string,
  options: {
    species?: string;
    type?: 'orthologues' | 'paralogues';
    target_species?: string;
    target_taxon?: number;
    limit?: number;
  } = {}
): Promise<EnsemblHomologyResult> {
  const species = options.species?.trim() || DEFAULT_SPECIES;
  const type = options.type ?? 'orthologues';
  const trimmed = gene.trim();
  if (!trimmed) throw new Error('gene is required');

  // NB: /homology/symbol proved flaky upstream (multi-second hangs during
  // probing and live testing) while /homology/id stayed fast — symbols are
  // resolved to stable IDs via /lookup first, then only /homology/id is hit.
  let geneId = trimmed;
  if (!isEnsemblGeneId(trimmed)) {
    const resolved = await resolveEnsemblGene(trimmed, species);
    if (!resolved.id) throw new Error(`Gene '${trimmed}' could not be resolved in Ensembl`);
    geneId = resolved.id;
  } else {
    geneId = bareGeneId(trimmed);
  }

  const params = [`type=${type}`];
  if (options.target_species) params.push(`target_species=${encodeURIComponent(options.target_species)}`);
  if (options.target_taxon !== undefined) params.push(`target_taxon=${options.target_taxon}`);

  const response = (await ensemblConn().request(
    `/homology/id/${encodeURIComponent(species)}/${encodeURIComponent(geneId)}?${params.join(';')}`
  )) as RawHomology;

  let entries: RawHomologyEntry[] = [];
  if (Array.isArray(response?.data)) {
    entries = response.data[0]?.homologies ?? [];
  } else if (response?.data && 'homologies' in response.data) {
    entries = response.data.homologies ?? [];
  } else {
    entries = response?.homologies ?? [];
  }

  const homologies: EnsemblHomologyEntry[] = entries.map(h => ({
    type: h.type ?? '',
    taxonomy_level: optStr(h.taxonomy_level),
    source_id: h.source?.id ?? '',
    source_species: h.source?.species ?? '',
    target: {
      id: h.target?.id ?? '',
      species: h.target?.species ?? '',
      taxon_id: num(h.target?.taxon_id),
      protein_id: optStr(h.target?.protein_id),
      // NB: dn/ds was observed null across sampled entries upstream — not surfaced.
      perc_id: num(h.target?.perc_id),
      perc_pos: num(h.target?.perc_pos),
    },
  }));

  homologies.sort((a, b) => (b.target.perc_id ?? -1) - (a.target.perc_id ?? -1));
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_HOMOLOGY_LIMIT, 1), MAX_HOMOLOGY_LIMIT);

  return {
    input: trimmed,
    species,
    type,
    total: homologies.length,
    returned: Math.min(homologies.length, limit),
    truncated: homologies.length > limit,
    homologies: homologies.slice(0, limit),
  };
}

function impactOf(tc: Record<string, unknown>): number {
  const impact = strOrEmpty(tc['impact']).toUpperCase();
  return IMPACT_RANK[impact] ?? 0;
}

function mapConsequence(tc: Record<string, unknown>): EnsemblConsequenceEffect {
  const terms = tc['consequence_terms'];
  return {
    transcript_id: strOrEmpty(tc['transcript_id']),
    gene_id: optStr(tc['gene_id']),
    gene_symbol: optStr(tc['gene_symbol']),
    biotype: optStr(tc['biotype']),
    consequence_terms: Array.isArray(terms) ? terms.filter((t): t is string => typeof t === 'string') : [],
    impact: optStr(tc['impact']),
    codons: optStr(tc['codons']),
    amino_acids: optStr(tc['amino_acids']),
    protein_start: num(tc['protein_start']),
    protein_end: num(tc['protein_end']),
    sift_prediction: optStr(tc['sift_prediction']),
    sift_score: num(tc['sift_score']),
    polyphen_prediction: optStr(tc['polyphen_prediction']),
    polyphen_score: num(tc['polyphen_score']),
  };
}

function mapColocated(cv: Record<string, unknown>): EnsemblColocatedVariant {
  const clinSig = cv['clin_sig'];
  const frequencies = cv['frequencies'];
  return {
    id: optStr(cv['id']),
    source: optStr(cv['source']),
    clin_sig: Array.isArray(clinSig) ? clinSig.filter((s): s is string => typeof s === 'string') : [],
    frequencies:
      frequencies && typeof frequencies === 'object' && !Array.isArray(frequencies)
        ? (frequencies as Record<string, unknown>)
        : null,
  };
}

function mapVepResult(
  input: string,
  species: string,
  result: RawVepResult,
  limit: number = DEFAULT_CONSEQUENCE_LIMIT
): EnsemblConsequenceResult {
  const all = (Array.isArray(result.transcript_consequences) ? result.transcript_consequences : [])
    .map(mapConsequence)
    .sort((a, b) => impactOf(b as unknown as Record<string, unknown>) - impactOf(a as unknown as Record<string, unknown>));
  const capped = Math.max(limit, 1);

  return {
    input,
    species,
    most_severe_consequence: optStr(result.most_severe_consequence),
    allele_string: optStr(result.allele_string),
    effects_total: all.length,
    effects_returned: Math.min(all.length, capped),
    consequences: all.slice(0, capped),
    colocated_variants: (Array.isArray(result.colocated_variants) ? result.colocated_variants : [])
      .slice(0, 5)
      .map(mapColocated),
  };
}

export async function ensemblConsequence(
  variant: string,
  options: { species?: string; limit?: number } = {}
): Promise<EnsemblConsequenceResult> {
  const species = options.species?.trim() || DEFAULT_SPECIES;
  const trimmed = variant.trim();
  if (!trimmed) throw new Error('variant is required');

  let result: RawVepResult;
  // NB: both VEP forms return an ARRAY of results (one per input variant).
  const unwrap = (response: unknown): RawVepResult => {
    const arr = Array.isArray(response) ? response : [response];
    return (arr[0] ?? {}) as RawVepResult;
  };
  if (RSID_RE.test(trimmed)) {
    // rsIDs are POST-only on the VEP REST API (the GET form does not exist).
    const conn = ensemblConn() as RestConnection;
    result = unwrap(await conn.post(`/vep/${encodeURIComponent(species)}/id`, { ids: [trimmed] }));
  } else if (HGVS_MINIMAL_RE.test(trimmed)) {
    result = unwrap(
      await ensemblConn().request(`/vep/${encodeURIComponent(species)}/hgvs/${encodeURIComponent(trimmed)}`)
    );
  } else {
    throw new Error(
      `'${trimmed}' is not supported — use HGVS notation (e.g. NM_004333:c.1799T>A) or a dbSNP rsID`
    );
  }

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_CONSEQUENCE_LIMIT, 1), MAX_CONSEQUENCE_LIMIT);
  return mapVepResult(trimmed, species, result, limit);
}

function mapRegionFeature(f: Record<string, unknown>): EnsemblRegionFeature {
  const featureType = strOrEmpty(f['feature_type']) || 'unknown';
  const consequenceType = f['consequence_type'];
  const clinical = f['clinical_significance'];
  const alleles = f['alleles'];
  return {
    type: featureType,
    id: strOrEmpty(f['gene_id'] ?? f['id']),
    symbol: optStr(f['external_name']),
    biotype: optStr(f['biotype']),
    chromosome: strOrEmpty(f['seq_region_name']),
    start: num(f['start']),
    end: num(f['end']),
    strand: num(f['strand']),
    alleles: Array.isArray(alleles) ? alleles.filter((a): a is string => typeof a === 'string') : null,
    consequence_types: Array.isArray(consequenceType)
      ? consequenceType.filter((t): t is string => typeof t === 'string')
      : typeof consequenceType === 'string'
        ? [consequenceType]
        : [],
    clinical_significance: Array.isArray(clinical)
      ? clinical.filter((s): s is string => typeof s === 'string')
      : [],
    source: optStr(f['source']),
  };
}

export async function ensemblRegion(
  region: string,
  options: {
    species?: string;
    features?: Array<(typeof REGION_ALLOWED_FEATURES)[number]>;
    limit?: number;
  } = {}
): Promise<EnsemblRegionResult> {
  const species = options.species?.trim() || DEFAULT_SPECIES;
  const features = options.features?.length ? options.features : ['gene', 'variation'];

  const invalid = features.filter(f => !(REGION_ALLOWED_FEATURES as readonly string[]).includes(f));
  if (invalid.length > 0) {
    throw new Error(`Unsupported feature(s): ${invalid.join(', ')} — allowed: ${REGION_ALLOWED_FEATURES.join(', ')}`);
  }

  const match = region.trim().match(/^([A-Za-z0-9._]+):(\d+)-(\d+)$/);
  if (!match) {
    throw new Error(`Invalid region '${region}' — expected chr:start-end (e.g. 7:140450000-140480000)`);
  }
  const [, chr, startStr, endStr] = match;
  const start = Number(startStr);
  const end = Number(endStr);
  if (end < start) throw new Error(`Invalid region '${region}' — end must be >= start`);
  if (end - start + 1 > REGION_MAX_SPAN_BP) {
    throw new Error(`Region span ${(end - start + 1).toLocaleString()} bp exceeds the ${REGION_MAX_SPAN_BP / 1_000_000} Mb upstream limit — narrow it`);
  }

  // NB: Ensembl requires REPEATED feature params (comma lists are rejected).
  // The semicolon-matrix form was verified live and passes through new URL()
  // untouched because buildUrl never touches searchParams without auth/env
  // query groups.
  const query = features.map(f => `feature=${f}`).join(';');
  const response = await ensemblConn().request(
    `/overlap/region/${encodeURIComponent(species)}/${chr}:${start}-${end}?${query}`
  );

  const rows = Array.isArray(response) ? (response as Array<Record<string, unknown>>) : [];
  const limit = Math.max(1, options.limit ?? DEFAULT_REGION_LIMIT);

  return {
    region: `${chr}:${start}-${end}`,
    species,
    features_requested: [...features],
    total: rows.length,
    returned: Math.min(rows.length, limit),
    truncated: rows.length > limit,
    features: rows.slice(0, limit).map(mapRegionFeature),
  };
}

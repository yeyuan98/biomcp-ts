import { connectionManager } from '../connections/manager.js';
import { fetchWithTimeout } from '../connections/fetch-utils.js';
import { transformPdbEntry } from '../transform/pdb.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY_TIMEOUT_MS = 15000;
const SECTION_TIMEOUT_MS = 8000;
const LARGE_FILE_WARN_BYTES = 1_000_000;
const PDB_ID_REGEX = /^[A-Za-z0-9]{4}$/;
const CSM_ID_PREFIX = /^(AF_|MA_)/i;

export interface PdbEntrySummary {
  pdb_id: string;
  title: string;
  experimental_method?: string;
  resolution?: number;
  molecular_weight?: number;
  polymer_count?: number;
  polymer_composition?: string;
  deposition_date?: string;
  release_date?: string;
  organism?: string;
  doi?: string;
  pmid?: string;
  authors?: string[];
  space_group?: string;
  unit_cell?: {
    a?: number;
    b?: number;
    c?: number;
    alpha?: number;
    beta?: number;
    gamma?: number;
  };
  container_ids?: {
    polymer_entity_ids: string[];
    non_polymer_entity_ids: string[];
    assembly_ids: string[];
  };
}

export interface PdbSearchResult {
  pdb_id: string;
  score?: number;
  summary?: PdbEntrySummary;
}

export interface PdbResult {
  pdb_id: string;
  summary: PdbEntrySummary;
  sections?: Record<string, unknown>;
}

export interface PdbDownloadResult {
  file_path: string;
  file_size_bytes: number;
  file_size_human: string;
  format: string;
  pdb_id: string;
  _warn?: string;
}

export interface PdbSearchOptions {
  limit?: number;
  offset?: number;
}

export function validatePdbId(pdbId: string): void {
  if (CSM_ID_PREFIX.test(pdbId)) {
    throw new Error(
      `Computed structure models (AlphaFold/CSM) are not available from RCSB PDB file download. Use https://alphafold.ebi.ac.uk/ for ${pdbId}.`
    );
  }
  if (!PDB_ID_REGEX.test(pdbId)) {
    throw new Error(
      `Invalid PDB ID "${pdbId}". PDB IDs must be exactly 4 alphanumeric characters (e.g., "1CRN", "4HHB").`
    );
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function pdbSearch(
  query: string,
  options: PdbSearchOptions = {}
): Promise<PdbSearchResult[]> {
  const { limit = 10, offset = 0 } = options;

  const conn = connectionManager.getConnection('pdb_search');
  const searchBody: Record<string, unknown> = {
    query: {
      type: 'terminal',
      service: 'full_text',
      parameters: { value: query },
    },
    return_type: 'entry',
    request_options: {
      paginate: { start: offset, rows: limit },
      results_verbosity: 'compact',
    },
  };

  const response = await (conn as any).post('/query', searchBody) as {
    result_set?: Array<{ identifier: string; score: number }>;
    total_count?: number;
  } | null;

  const hits = response?.result_set ?? [];
  if (hits.length === 0) return [];

  const ids: string[] = hits.map((h: any) => {
    if (typeof h === 'string') return h;
    return h.identifier;
  }).filter(Boolean);

  const summaryPromises = ids.map(id =>
    fetchWithTimeout(async () => {
      const dataConn = connectionManager.getConnection('pdb_data');
      const raw = await dataConn.request(`/core/entry/${id}`) as Record<string, unknown>;
      return { id, summary: transformPdbEntry(id, raw as any) };
    }, ENTRY_TIMEOUT_MS)
  );

  const settled = await Promise.allSettled(summaryPromises);
  const summaryMap = new Map<string, PdbEntrySummary>();
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value.data) {
      summaryMap.set(result.value.data.id.toUpperCase(), result.value.data.summary);
    }
  }

  return ids.map((id, i) => ({
    pdb_id: id.toUpperCase(),
    score: typeof hits[i] === 'object' ? (hits[i] as any).score : undefined,
    summary: summaryMap.get(id.toUpperCase()),
  }));
}

export async function pdbGet(
  pdbId: string,
  sections?: string[]
): Promise<PdbResult> {
  validatePdbId(pdbId);

  const conn = connectionManager.getConnection('pdb_data');
  const { data: raw, error: entryError } = await fetchWithTimeout(
    () => conn.request(`/core/entry/${pdbId}`) as Promise<Record<string, unknown>>,
    ENTRY_TIMEOUT_MS
  );
  if (entryError || !raw) {
    throw new Error(`Failed to fetch PDB entry ${pdbId}: ${entryError ?? 'no data returned'}`);
  }
  const summary = transformPdbEntry(pdbId, raw as any);

  const result: PdbResult = { pdb_id: pdbId, summary };

  const sectionConfig = sections ?? [];
  const sectionsToFetch = sectionConfig.includes('all')
    ? ['polymer_entities', 'ligands', 'assembly', 'experiment', 'citation']
    : sectionConfig.filter(s => s !== 'core');

  if (sectionsToFetch.length > 0) {
    const sectionPromises = sectionsToFetch.map(section =>
      fetchWithTimeout(async () => {
        switch (section) {
          case 'polymer_entities': return { section, data: await fetchPolymerEntities(pdbId, summary.container_ids) };
          case 'ligands': return { section, data: await fetchLigands(pdbId, summary.container_ids) };
          case 'assembly': return { section, data: await fetchAssembly(pdbId, summary.container_ids) };
          case 'experiment': return { section, data: await fetchExperiment(pdbId, raw) };
          case 'citation': return { section, data: await fetchCitation(pdbId, raw) };
          default: return { section, data: null };
        }
      }, SECTION_TIMEOUT_MS)
    );

    const settledResults = await Promise.allSettled(sectionPromises);
    result.sections = {};
    for (let si = 0; si < settledResults.length; si++) {
      const settled = settledResults[si];
      const sectionName = sectionsToFetch[si];
      if (settled.status === 'fulfilled' && settled.value.data) {
        const sectionData = settled.value.data as { section: string; data: unknown };
        (result.sections as Record<string, unknown>)[sectionData.section] = sectionData.data;
      } else if (settled.status === 'fulfilled' && settled.value.error) {
        (result.sections as Record<string, unknown>)[sectionName] = { error: settled.value.error };
      } else if (settled.status === 'rejected') {
        const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
        (result.sections as Record<string, unknown>)[sectionName] = {
          error: `Section '${sectionName}' fetch failed: ${reason}`,
        };
      }
    }
  }

  return result;
}

export async function pdbDownload(
  pdbId: string,
  format: 'cif' | 'pdb' = 'cif'
): Promise<PdbDownloadResult> {
  validatePdbId(pdbId);

  const ext = format === 'pdb' ? 'pdb' : 'cif';
  const conn = connectionManager.getConnection('pdb_files');

  let content: string;
  try {
    content = (await conn.request(`/download/${pdbId.toLowerCase()}.${ext}`)) as string;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('404')) {
      throw new Error(
        `PDB format not available for ${pdbId}. This entry may only have mmCIF format. Retry with format='cif'.`
      );
    }
    throw error;
  }

  const bytes = Buffer.byteLength(content, 'utf-8');
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdb_'));
  const fileName = `pdb_${pdbId.toLowerCase()}_${format}_${Date.now()}.${ext}`;
  const filePath = join(tmpDir, fileName);

  writeFileSync(filePath, content, 'utf-8');

  const result: PdbDownloadResult = {
    file_path: filePath,
    file_size_bytes: bytes,
    file_size_human: formatFileSize(bytes),
    format,
    pdb_id: pdbId.toUpperCase(),
  };

  if (bytes > LARGE_FILE_WARN_BYTES) {
    result._warn = `File is large (${formatFileSize(bytes)}). Use grep or read specific line ranges rather than loading the entire file.`;
  }

  return result;
}

async function fetchPolymerEntities(
  pdbId: string,
  containerIds?: { polymer_entity_ids?: string[] }
): Promise<unknown[]> {
  const entityIds = containerIds?.polymer_entity_ids ?? [];
  if (entityIds.length === 0) {
    return [{ _error: 'No polymer entities found for this entry.' } as any];
  }

  try {
    const conn = connectionManager.getConnection('pdb_data');
    const id = pdbId.toLowerCase();
    const promises = entityIds.map(entityId =>
      conn.request(`/core/polymer_entity/${id}/${entityId}`)
    );
    const results = await Promise.allSettled(promises);
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { _error: `Failed to fetch polymer entity ${entityIds[i]}: ${reason}` } as any;
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Polymer entity lookup failed (source: pdb_data): ${msg}` } as any];
  }
}

async function fetchLigands(
  pdbId: string,
  containerIds?: { non_polymer_entity_ids?: string[] }
): Promise<unknown[]> {
  const entityIds = containerIds?.non_polymer_entity_ids ?? [];
  if (entityIds.length === 0) {
    return [];
  }

  try {
    const conn = connectionManager.getConnection('pdb_data');
    const id = pdbId.toLowerCase();
    const promises = entityIds.map(entityId =>
      conn.request(`/core/nonpolymer_entity/${id}/${entityId}`)
    );
    const results = await Promise.allSettled(promises);
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { _error: `Failed to fetch non-polymer entity ${entityIds[i]}: ${reason}` } as any;
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Ligand lookup failed (source: pdb_data): ${msg}` } as any];
  }
}

async function fetchAssembly(
  pdbId: string,
  containerIds?: { assembly_ids?: string[] }
): Promise<unknown[]> {
  const assemblyIds = containerIds?.assembly_ids ?? [];
  if (assemblyIds.length === 0) {
    return [];
  }

  try {
    const conn = connectionManager.getConnection('pdb_data');
    const id = pdbId.toLowerCase();
    const promises = assemblyIds.map(assemblyId =>
      conn.request(`/core/assembly/${id}/${assemblyId}`)
    );
    const results = await Promise.allSettled(promises);
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { _error: `Failed to fetch assembly ${assemblyIds[i]}: ${reason}` } as any;
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [{ _error: `Assembly lookup failed (source: pdb_data): ${msg}` } as any];
  }
}

async function fetchExperiment(
  _pdbId: string,
  rawEntry: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const exptl = rawEntry.exptl as Array<Record<string, unknown>> | undefined;
  const refine = rawEntry.refine as Array<Record<string, unknown>> | undefined;
  const em = rawEntry.em_3d_reconstruction as Record<string, unknown> | undefined;

  return {
    methods: exptl?.map(e => e.method).filter(Boolean),
    refinement: refine?.map(r => ({
      resolution_high: r.ls_d_res_high,
      resolution_low: r.ls_d_res_low,
      r_free: r.rfactor_free,
      r_work: r.rfactor_work,
    })),
    em_resolution: em?.resolution,
    em_method: em?.reconstruction_method,
  };
}

async function fetchCitation(
  _pdbId: string,
  rawEntry: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const citation = rawEntry.rcsb_primary_citation as Record<string, unknown> | undefined;
  if (!citation) return {};

  return {
    title: citation.title,
    doi: citation.pdbx_database_id_DOI,
    pmid: citation.pdbx_database_id_PubMed,
    authors: (citation.authors as Array<Record<string, unknown>>)?.map(a => a.name).filter(Boolean),
    journal: citation.journal_abbrev,
    year: citation.year,
    volume: citation.volume,
    page_first: citation.page_first,
    page_last: citation.page_last,
  };
}

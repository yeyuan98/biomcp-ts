import { connectionManager } from '../../connections/manager.js';
import { parseEutilsResponse, assertEutilsText, chunkUids, joinUidParam } from '../eutils-utils.js';
import { parseExperimentPackageSet } from './transform/experiment-package.js';
import type { SraLibrary, SraRecord, SraRun } from './transform/experiment-package.js';

export type { SraLibrary, SraRecord, SraRun } from './transform/experiment-package.js';

/** SRA efetch responses are multi-MB; fetch far below the 200-id eutils cap. */
const SRA_EFETCH_BATCH = 10;
const SRA_SEARCH_MAX = 50;
const SRA_DETAIL_LIST_CAP = 50;

export interface SraSearchResultItem {
  experiment_accession: string;
  study_accession?: string;
  sample_accession?: string;
  organism?: string;
  library_strategy?: string;
  run_count: number;
  first_run_accession?: string;
  bioproject?: string;
}

export interface SraStudyExperiment {
  experiment_accession: string;
  sample_accession?: string;
  organism?: string;
  library_strategy?: string;
  runs: string[];
}

export interface SraRunDetail {
  entry_type: 'run';
  accession: string;
  experiment_accession?: string;
  study_accession?: string;
  sample_accession?: string;
  organism?: string;
  library: SraLibrary;
  platform_vendor?: string;
  instrument_model?: string;
  total_spots?: number;
  total_bases?: number;
  size_bytes?: number;
  published?: string;
  bioproject?: string;
}

export interface SraExperimentDetail extends SraRecord {
  entry_type: 'experiment';
  accession: string;
}

export interface SraStudyDetail {
  entry_type: 'study';
  accession: string;
  study_title?: string;
  study_type?: string;
  bioproject?: string;
  center_name?: string;
  submission_accession?: string;
  total_experiments: number;
  experiments: SraStudyExperiment[];
}

export interface SraSampleDetail {
  entry_type: 'sample';
  accession: string;
  organism?: string;
  taxon_id?: string;
  sample_title?: string;
  total_experiments: number;
  experiments: SraStudyExperiment[];
}

export type SraDetail = SraRunDetail | SraExperimentDetail | SraStudyDetail | SraSampleDetail;

interface SraEsearchEnvelope {
  esearchresult?: {
    error?: unknown;
    count?: string;
    idlist?: string[];
  };
}

async function esearchSraUids(
  term: string,
  retmax: number,
  retstart: number = 0
): Promise<{ total: number; ids: string[] }> {
  const conn = connectionManager.getConnection('eutils');
  const path =
    `/esearch.fcgi?db=sra&term=${encodeURIComponent(term)}` +
    `&retmode=json&retmax=${retmax}&retstart=${retstart}`;
  const response = await conn.request(path);
  const parsed = parseEutilsResponse<SraEsearchEnvelope>(response, 'SRA search');
  const ids = parsed.esearchresult?.idlist ?? [];
  const count = Number(parsed.esearchresult?.count ?? ids.length);
  return { total: Number.isFinite(count) ? count : ids.length, ids };
}

async function efetchExperimentPackages(uids: string[]): Promise<SraRecord[]> {
  if (uids.length === 0) return [];
  const conn = connectionManager.getConnection('eutils');
  const response = await conn.request(
    `/efetch.fcgi?db=sra&id=${joinUidParam(uids, SRA_EFETCH_BATCH)}`
  );
  if (typeof response !== 'string') {
    throw new Error('SRA efetch returned a non-XML response');
  }
  return parseExperimentPackageSet(assertEutilsText(response, 'SRA fetch'));
}

async function fetchAllPackages(uids: string[]): Promise<SraRecord[]> {
  const records: SraRecord[] = [];
  const capped = uids.slice(0, SRA_DETAIL_LIST_CAP);
  for (const batch of chunkUids(capped, SRA_EFETCH_BATCH)) {
    records.push(...(await efetchExperimentPackages(batch)));
  }
  return records;
}

function toSearchItem(record: SraRecord): SraSearchResultItem {
  return {
    experiment_accession: record.experiment_accession,
    study_accession: record.study_accession,
    sample_accession: record.sample_accession,
    organism: record.organism,
    library_strategy: record.library.strategy,
    run_count: record.run_accessions.length,
    first_run_accession: record.run_accessions[0]?.accession,
    bioproject: record.bioproject,
  };
}

function toStudyExperiment(record: SraRecord): SraStudyExperiment {
  return {
    experiment_accession: record.experiment_accession,
    sample_accession: record.sample_accession,
    organism: record.organism,
    library_strategy: record.library.strategy,
    runs: record.run_accessions.map(run => run.accession),
  };
}

function sraNotFound(accession: string): Error {
  return new Error(
    `SRA accession ${accession} not found in NCBI SRA. European accessions (ERP/ERR) and DDBJ accessions (DRP/DRR) are NOT indexed in NCBI SRA — for those, use ENA at https://www.ebi.ac.uk/ena (search by accession). Also check the accession for typos.`
  );
}

export async function sraSearch(
  query: string,
  options: { limit?: number; offset?: number } = {}
): Promise<SraSearchResultItem[]> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), SRA_SEARCH_MAX);
  const offset = Math.max(options.offset ?? 0, 0);

  const { ids } = await esearchSraUids(query, limit, offset);
  if (ids.length === 0) return [];

  const records: SraRecord[] = [];
  for (const batch of chunkUids(ids, SRA_EFETCH_BATCH)) {
    records.push(...(await efetchExperimentPackages(batch)));
  }
  return records.map(toSearchItem);
}

export async function sraGet(accession: string): Promise<SraDetail> {
  const trimmed = accession.trim();
  const upper = trimmed.toUpperCase();

  const { total, ids } = await esearchSraUids(trimmed, SRA_SEARCH_MAX);
  if (ids.length === 0) throw sraNotFound(trimmed);

  if (upper.startsWith('SRR')) return buildRunDetail(trimmed, ids[0]);
  if (upper.startsWith('SRP')) return buildStudyDetail(trimmed, total, ids);
  if (upper.startsWith('SRS')) return buildSampleDetail(trimmed, total, ids);
  return buildExperimentDetail(trimmed, ids[0]);
}

async function buildExperimentDetail(accession: string, uid: string): Promise<SraDetail> {
  const packages = await efetchExperimentPackages([uid]);
  const record = packages[0];
  if (!record) throw sraNotFound(accession);
  return { entry_type: 'experiment', accession, ...record };
}

async function buildRunDetail(accession: string, uid: string): Promise<SraDetail> {
  const packages = await efetchExperimentPackages([uid]);
  for (const record of packages) {
    const run = record.run_accessions.find(
      candidate => candidate.accession.toUpperCase() === accession.toUpperCase()
    );
    if (run) {
      return {
        entry_type: 'run',
        accession: run.accession,
        experiment_accession: record.experiment_accession,
        study_accession: record.study_accession,
        sample_accession: record.sample_accession,
        organism: record.organism,
        library: record.library,
        platform_vendor: record.platform_vendor,
        instrument_model: record.instrument_model,
        total_spots: run.total_spots,
        total_bases: run.total_bases,
        size_bytes: run.size_bytes,
        published: run.published,
        bioproject: record.bioproject,
      };
    }
  }
  throw sraNotFound(accession);
}

async function buildStudyDetail(
  accession: string,
  total: number,
  uids: string[]
): Promise<SraDetail> {
  const packages = await fetchAllPackages(uids);
  const first = packages[0];
  return {
    entry_type: 'study',
    accession,
    study_title: first?.study_title,
    study_type: first?.study_type,
    bioproject: first?.bioproject,
    center_name: first?.center_name,
    submission_accession: first?.submission_accession,
    total_experiments: total,
    experiments: packages.slice(0, SRA_DETAIL_LIST_CAP).map(toStudyExperiment),
  };
}

async function buildSampleDetail(
  accession: string,
  total: number,
  uids: string[]
): Promise<SraDetail> {
  const packages = await fetchAllPackages(uids);
  const matching = packages.filter(
    record => record.sample_accession?.toUpperCase() === accession.toUpperCase()
  );
  if (matching.length === 0) throw sraNotFound(accession);
  const first = matching[0];
  return {
    entry_type: 'sample',
    accession,
    organism: first.organism,
    taxon_id: first.taxon_id,
    sample_title: first.sample_title,
    total_experiments: total,
    experiments: matching.slice(0, SRA_DETAIL_LIST_CAP).map(toStudyExperiment),
  };
}

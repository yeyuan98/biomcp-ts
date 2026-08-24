import { connectionManager } from '../connections/manager.js';
import { assertEutilsText, joinUidParam, parseEutilsResponse } from './eutils-utils.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_UNRESTRICTED_FETCH_BP = 2_000_000;
const MAX_REGION_SPAN_BP = 10_000_000;
const GBWITHPARTS_THRESHOLD_BP = 20_000_000;
const DEFAULT_MAX_RESPONSE_BYTES = 30_000_000;
const MAX_GENE_LINKS = 100;

const ACCESSION_RE = /^[A-Z]{1,2}_?\d+(\.\d+)?$/i;

export interface GenbankSearchResult {
  accession: string;
  definition: string;
  length_bp: number;
  organism: string;
  taxon_id: number;
  biomol: string;
  topology: string;
  sourcedb: string;
  chromosome: string;
  updated: string;
}

export interface GenbankMetadata {
  accession_version: string;
  definition: string;
  length_bp: number;
  organism: string;
  taxon_id: number;
  biomol: string;
  topology: string;
  sourcedb: string;
  chromosome: string;
  created: string;
  updated: string;
  uid: string;
}

export interface GenbankRegion {
  start: number;
  stop: number;
  strand: 1 | 2;
}

export interface GenbankRecord {
  accession: string;
  definition: string;
  organism: string;
  taxon_id: number;
  length_bp: number;
  topology: string;
  biomol: string;
  sourcedb: string;
  region?: GenbankRegion;
  format: 'genbank' | 'fasta';
  sequence_text: string;
}

export interface GenbankSearchOptions {
  organism?: string;
  limit?: number;
  offset?: number;
}

export interface GenbankGetOptions {
  format?: 'genbank' | 'fasta';
  seq_start?: number;
  seq_stop?: number;
  strand?: 1 | 2;
  maxResponseBytes?: number;
}

interface EsummaryDoc {
  uid?: string;
  caption?: string;
  title?: string;
  slen?: number;
  taxid?: number;
  organism?: string;
  biomol?: string;
  topology?: string;
  sourcedb?: string;
  subtype?: string;
  subname?: string;
  accessionversion?: string;
  createdate?: string;
  updatedate?: string;
}

interface EsummaryResponse {
  result?: { uids?: string[]; error?: unknown } & Record<string, unknown>;
}

interface EsearchResponse {
  esearchresult?: { idlist?: string[]; error?: unknown };
}

interface ElinkResponse {
  linksets?: Array<{
    dbfrom?: string;
    ids?: string[];
    linksetdbs?: Array<{ dbto?: string; linkname?: string; links?: string[] }>;
  }>;
}

/**
 * E-utilities JSON endpoints come back through RestConnection as parsed
 * objects (content-type: application/json); a text/plain reply stays a
 * string. Route both through the shared guard so the error envelope is
 * always checked.
 */
function parseEutilsJsonGuarded<T extends object>(response: unknown, context: string): T {
  return parseEutilsResponse<T & { error?: unknown }>(response, context) as T;
}

function extractChromosome(subtype?: string, subname?: string): string {
  if (!subtype || !subname) return '';
  const names = subname.split('|');
  const index = subtype.split('|').indexOf('chromosome');
  if (index < 0 || index >= names.length) return '';
  return names[index];
}

function toMetadata(uid: string, doc: EsummaryDoc): GenbankMetadata {
  return {
    accession_version: doc.accessionversion ?? doc.caption ?? uid,
    definition: doc.title ?? '',
    length_bp: doc.slen ?? 0,
    organism: doc.organism ?? '',
    taxon_id: doc.taxid ?? 0,
    biomol: doc.biomol ?? '',
    topology: doc.topology ?? '',
    sourcedb: doc.sourcedb ?? '',
    chromosome: extractChromosome(doc.subtype, doc.subname),
    created: doc.createdate ?? '',
    updated: doc.updatedate ?? '',
    uid,
  };
}

function validateAccession(accession: string): string {
  const trimmed = accession.trim();
  if (!ACCESSION_RE.test(trimmed)) {
    throw new Error(
      `Invalid GenBank accession '${accession}'. Expected forms like NC_000023.11, NG_017013.2, CP002059.1 (RefSeq) or U12345, KJ668569.2 (GenBank/INSDC).`
    );
  }
  return trimmed;
}

async function fetchSummary(accession: string): Promise<GenbankMetadata> {
  const conn = connectionManager.getConnection('eutils');
  const query = new URLSearchParams({ db: 'nuccore', id: accession, retmode: 'json' });
  const response = await conn.request(`/esummary.fcgi?${query.toString()}`);
  const context = `NCBI nuccore esummary for '${accession}'`;
  const parsed = parseEutilsJsonGuarded<EsummaryResponse>(response, context);
  const uid = parsed.result?.uids?.[0];
  if (!uid) {
    throw new Error(`Accession '${accession}' not found in NCBI nuccore.`);
  }
  return toMetadata(uid, (parsed.result as Record<string, unknown>)?.[uid] as EsummaryDoc | undefined ?? {});
}

export async function genbankSearch(
  query: string,
  options: GenbankSearchOptions = {}
): Promise<GenbankSearchResult[]> {
  const conn = connectionManager.getConnection('eutils');
  const term = options.organism
    ? `${query} AND ${options.organism}[Organism]`
    : query;
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 0), MAX_SEARCH_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);

  const searchQuery = new URLSearchParams({
    db: 'nuccore',
    term,
    retmode: 'json',
    retmax: String(limit),
    retstart: String(offset),
  });
  const searchResponse = await conn.request(`/esearch.fcgi?${searchQuery.toString()}`);
  const searchParsed = parseEutilsJsonGuarded<EsearchResponse>(searchResponse, `NCBI nuccore esearch for '${term}'`);
  const uids = searchParsed.esearchresult?.idlist ?? [];
  if (uids.length === 0) return [];

  const summaryQuery = new URLSearchParams({
    db: 'nuccore',
    id: joinUidParam(uids),
    retmode: 'json',
  });
  const summaryResponse = await conn.request(`/esummary.fcgi?${summaryQuery.toString()}`);
  const summaryParsed = parseEutilsJsonGuarded<EsummaryResponse>(summaryResponse, `NCBI nuccore esummary for '${term}'`);
  const docs = summaryParsed.result ?? ({} as Record<string, unknown>);

  return uids
    .map(uid => {
      const doc = (docs as Record<string, unknown>)[uid] as EsummaryDoc | undefined;
      return doc ? toMetadata(uid, doc) : undefined;
    })
    .filter((m): m is GenbankMetadata => m !== undefined)
    .map(m => ({
      accession: m.accession_version,
      definition: m.definition,
      length_bp: m.length_bp,
      organism: m.organism,
      taxon_id: m.taxon_id,
      biomol: m.biomol,
      topology: m.topology,
      sourcedb: m.sourcedb,
      chromosome: m.chromosome,
      updated: m.updated,
    }));
}

export async function genbankGet(
  accession: string,
  options: GenbankGetOptions = {}
): Promise<GenbankRecord> {
  const identifier = validateAccession(accession);
  const conn = connectionManager.getConnection('eutils');
  const metadata = await fetchSummary(identifier);

  const hasStart = options.seq_start !== undefined;
  const hasStop = options.seq_stop !== undefined;
  const hasRegion = hasStart || hasStop;
  const format = options.format ?? 'genbank';

  if (options.strand !== undefined && !hasRegion) {
    throw new Error(`strand requires seq_start and seq_stop — provide a region for '${identifier}'.`);
  }

  let seqStart = 0;
  let seqStop = 0;
  if (hasRegion) {
    if (!hasStart || !hasStop) {
      throw new Error('Provide both seq_start and seq_stop (1-based, inclusive) to fetch a region.');
    }
    seqStart = options.seq_start!;
    seqStop = options.seq_stop!;
    if (seqStart < 1 || seqStop < 1) {
      throw new Error(`Region coordinates must be >= 1 (1-based, inclusive); got seq_start=${seqStart}, seq_stop=${seqStop}.`);
    }
    if (seqStart > metadata.length_bp || seqStop > metadata.length_bp) {
      throw new Error(
        `Region seq_start=${seqStart}..seq_stop=${seqStop} exceeds record ${metadata.accession_version} length ${metadata.length_bp} bp.`
      );
    }
    if (seqStart > seqStop && options.strand !== 2) {
      throw new Error(
        `seq_start (${seqStart}) > seq_stop (${seqStop}) is only valid for a reverse-strand slice — set strand=2.`
      );
    }
    const span = Math.abs(seqStop - seqStart) + 1;
    if (span > MAX_REGION_SPAN_BP) {
      throw new Error(
        `Region ${seqStart}..${seqStop} spans ${span} bp — exceeds the ${MAX_REGION_SPAN_BP} bp maximum for region fetches.`
      );
    }
  } else if (metadata.length_bp > MAX_UNRESTRICTED_FETCH_BP) {
    throw new Error(
      `Record ${metadata.accession_version} is ${metadata.length_bp} bp — too large to fetch whole. ` +
        `Provide seq_start and seq_stop (1-based, inclusive) to retrieve a region (max ~2 Mb), e.g. seq_start=1000000&seq_stop=1002000.`
    );
  }

  const rettype = format === 'fasta'
    ? 'fasta'
    : metadata.length_bp > GBWITHPARTS_THRESHOLD_BP ? 'gbwithparts' : 'gb';
  const fetchQuery = new URLSearchParams({
    db: 'nuccore',
    id: identifier,
    rettype,
    retmode: 'text',
  });
  if (hasRegion) {
    fetchQuery.set('seq_start', String(seqStart));
    fetchQuery.set('seq_stop', String(seqStop));
  }
  if (options.strand !== undefined) {
    fetchQuery.set('strand', String(options.strand));
  }

  const raw = await conn.request(`/efetch.fcgi?${fetchQuery.toString()}`);
  if (typeof raw !== 'string') {
    throw new Error(`NCBI nuccore efetch for '${identifier}': expected a text response.`);
  }
  const context = `NCBI nuccore efetch for '${identifier}'`;
  const text = assertEutilsText(raw, context);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (text.length > maxResponseBytes) {
    throw new Error(
      `${context}: response is ${text.length} characters — exceeds maxResponseBytes (${maxResponseBytes}). Narrow the region via seq_start/seq_stop.`
    );
  }

  const record: GenbankRecord = {
    accession: metadata.accession_version,
    definition: metadata.definition,
    organism: metadata.organism,
    taxon_id: metadata.taxon_id,
    length_bp: metadata.length_bp,
    topology: metadata.topology,
    biomol: metadata.biomol,
    sourcedb: metadata.sourcedb,
    format,
    sequence_text: text,
  };
  if (hasRegion) {
    record.region = { start: seqStart, stop: seqStop, strand: options.strand ?? 1 };
  }
  return record;
}

export async function genbankToGeneIds(accession: string): Promise<number[]> {
  const identifier = validateAccession(accession);
  const conn = connectionManager.getConnection('eutils');
  const metadata = await fetchSummary(identifier);

  const query = new URLSearchParams({
    dbfrom: 'nuccore',
    db: 'gene',
    id: metadata.uid,
    retmode: 'json',
  });
  const response = await conn.request(`/elink.fcgi?${query.toString()}`);
  const context = `NCBI elink nuccore->gene for '${identifier}'`;
  const parsed = parseEutilsJsonGuarded<ElinkResponse>(response, context);

  const links = parsed.linksets?.[0]?.linksetdbs?.find(db => db.dbto === 'gene')?.links ?? [];
  return links
    .map(link => Number(link))
    .filter(geneId => Number.isInteger(geneId))
    .slice(0, MAX_GENE_LINKS);
}

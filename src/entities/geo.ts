import { connectionManager } from '../connections/manager.js';
// Side-effect import: proxy-aware global fetch for supplementary downloads.
import '../connections/fetch-utils.js';
import { parseEutilsResponse, assertEutilsText, chunkUids, joinUidParam } from './eutils-utils.js';
import { parseSoftRecord, getSoftValue, getSoftValues, type SoftRecord } from '../transform/soft.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GEO_SEARCH_MAX_LIMIT = 50;
const GEO_SAMPLES_PREVIEW = 20;
const GEO_SUMMARY_TRUNCATE = 500;
const GEO_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const GEO_MIN_MAX_BYTES = 1024 * 1024;

const GEO_ACCESSION_REGEX = /^(GSE|GSM|GPL|GDS)(\d+)$/i;
const SRA_TOKEN_REGEX = /\bSR[PRSX]\d+\b/g;
const BIOPROJECT_TOKEN_REGEX = /\bPRJ[A-Z]{1,3}\d+\b/;

export interface GeoDownloadedFile {
  path: string;
  size_bytes: number;
  filename: string;
  url: string;
}

export interface GeoSearchResult {
  accession: string;
  entry_type: string;
  title: string;
  summary?: string;
  organism?: string;
  gds_type?: string;
  platform?: string;
  publication_date?: string;
  n_samples?: number;
  pubmed_ids?: number[];
  bioproject?: string;
  sra_project?: string;
  supplementary_file_format?: string;
  uid: string;
}

export interface GeoSeriesDetail {
  accession: string;
  entry_type: 'series';
  title: string;
  status?: string;
  submission_date?: string;
  last_update_date?: string;
  publication_date?: string;
  type?: string;
  overall_design?: string;
  summary?: string;
  organisms: string[];
  contributor_names: string[];
  platform_ids: string[];
  supplementary_files: string[];
  samples: Array<{ accession: string; title?: string }>;
  n_samples: number;
  pubmed_ids: number[];
  bioproject?: string;
  sra: string[];
  super_series: string[];
  sub_series: string[];
  relations_raw: string[];
  download?: GeoDownloadedFile;
}

export interface GeoSampleDetail {
  accession: string;
  entry_type: 'sample';
  title: string;
  status?: string;
  source_name?: string;
  organism?: string;
  characteristics: string[];
  platform_id?: string;
  supplementary_files: string[];
  series?: string;
  sra: string[];
  relations_raw: string[];
  download?: GeoDownloadedFile;
}

export interface GeoPlatformDetail {
  accession: string;
  entry_type: 'platform';
  title: string;
  status?: string;
  technology?: string;
  organisms: string[];
  supplementary_files: string[];
  relations_raw: string[];
  sra: string[];
  download?: GeoDownloadedFile;
}

export type GeoDetail = GeoSeriesDetail | GeoSampleDetail | GeoPlatformDetail;

export interface GeoSearchOptions {
  entryType?: 'gse' | 'gsm' | 'gpl' | 'gds';
  organism?: string;
  limit?: number;
  offset?: number;
}

export interface GeoGetOptions {
  download?: boolean;
  maxBytes?: number;
}

interface EsearchResponse {
  esearchresult?: {
    count?: string;
    idlist?: string[];
  };
}

interface GdsSummaryEntry {
  uid?: string;
  accession?: string;
  title?: string;
  summary?: string;
  gpl?: string;
  taxon?: string;
  entrytype?: string;
  gdstype?: string;
  pdat?: string;
  suppfile?: string;
  n_samples?: number;
  samples?: Array<{ accession?: string; title?: string }>;
  pubmedids?: number[];
  bioproject?: string;
  extrelations?: Array<{ relationtype?: string; targetobject?: string }>;
}

interface EsummaryGdsResponse {
  result?: { uids?: string[] } & Record<string, unknown>;
}

interface ElinkResponse {
  linksets?: Array<{
    linksetdbs?: Array<{ dbto?: string; linkname?: string; links?: string[] }>;
  }>;
}

interface GdsEnrichment {
  nSamples?: number;
  samplePreview?: Array<{ accession: string; title?: string }>;
  pdat?: string;
  taxon?: string;
  bioproject?: string;
  pubmedIds?: number[];
  sraTokens?: string[];
}

/** eutils JSON call through the shared application-error guard. */
async function eutilsJson<T extends object>(path: string, context: string): Promise<T> {
  const conn = connectionManager.getConnection('eutils');
  return parseEutilsResponse(await conn.request(path), context) as unknown as T;
}

async function esearchGdsUid(accession: string): Promise<string | undefined> {
  const parsed = await eutilsJson<EsearchResponse>(
    `/esearch.fcgi?db=gds&term=${encodeURIComponent(`${accession}[Accession]`)}&retmode=json&retmax=1`,
    'GEO accession lookup'
  );
  return parsed.esearchresult?.idlist?.[0];
}

async function esummaryGdsEntries(uids: string[]): Promise<Map<string, GdsSummaryEntry>> {
  const entries = new Map<string, GdsSummaryEntry>();
  for (const batch of chunkUids(uids)) {
    const parsed = await eutilsJson<EsummaryGdsResponse>(
      `/esummary.fcgi?db=gds&id=${joinUidParam(batch)}&retmode=json`,
      'GEO dataset summary'
    );
    for (const uid of parsed.result?.uids ?? []) {
      const entry = (parsed.result as Record<string, unknown>)?.[uid] as GdsSummaryEntry | undefined;
      if (entry) entries.set(uid, entry);
    }
  }
  return entries;
}

function normalizePlatformId(gpl?: string): string | undefined {
  if (!gpl) return undefined;
  if (/^GPL/i.test(gpl)) return gpl.toUpperCase();
  if (/^\d+$/.test(gpl)) return `GPL${gpl}`;
  return gpl;
}

function truncateSummary(summary: string): string {
  return summary.length > GEO_SUMMARY_TRUNCATE
    ? `${summary.slice(0, GEO_SUMMARY_TRUNCATE - 3)}...`
    : summary;
}

export async function geoSearch(query: string, options: GeoSearchOptions = {}): Promise<GeoSearchResult[]> {
  const { entryType, organism, limit = 10, offset = 0 } = options;

  let term = query;
  if (entryType) term += ` AND ${entryType}[ETYP]`;
  if (organism) term += ` AND ${organism}[ORGN]`;
  const retmax = Math.max(Math.min(limit, GEO_SEARCH_MAX_LIMIT), 1);

  const parsed = await eutilsJson<EsearchResponse>(
    `/esearch.fcgi?db=gds&term=${encodeURIComponent(term)}&retmode=json&retmax=${retmax}&retstart=${offset}`,
    'GEO dataset search'
  );
  const uids = parsed.esearchresult?.idlist ?? [];
  if (uids.length === 0) return [];

  const entries = await esummaryGdsEntries(uids);
  const results: GeoSearchResult[] = [];
  for (const uid of uids) {
    const entry = entries.get(uid);
    if (!entry) continue;
    const sraProject = entry.extrelations
      ?.find(rel => rel.relationtype === 'SRA')?.targetobject;
    results.push({
      accession: entry.accession ?? '',
      entry_type: entry.entrytype ?? '',
      title: entry.title ?? '',
      summary: entry.summary ? truncateSummary(entry.summary) : undefined,
      organism: entry.taxon,
      gds_type: entry.gdstype,
      platform: normalizePlatformId(entry.gpl),
      publication_date: entry.pdat,
      // n_samples preferred over samples.length — esummary gds embeds the
      // full (potentially 10k+) samples array for mega-series.
      n_samples: entry.n_samples ?? entry.samples?.length,
      pubmed_ids: entry.pubmedids,
      bioproject: entry.bioproject,
      sra_project: sraProject,
      supplementary_file_format: entry.suppfile,
      uid,
    });
  }
  return results;
}

function validateGeoAccession(accession: string): string {
  const normalized = accession.trim().toUpperCase();
  const match = GEO_ACCESSION_REGEX.exec(normalized);
  if (!match) {
    throw new Error(
      `Invalid GEO accession "${accession}". Expected GSE<n>, GSM<n>, or GPL<n> (e.g. GSE183947, GSM5574685, GPL11154).`
    );
  }
  if (match[1] === 'GDS') {
    throw new Error(
      `GDS accessions (e.g. ${normalized}) refer to curated GEO DataSet records, which are not available via the SOFT endpoint. Use the underlying series accession (GSE...) or sample accession (GSM...) instead.`
    );
  }
  return normalized;
}

async function fetchSoftText(accession: string): Promise<string> {
  const conn = connectionManager.getConnection('geo_soft');
  const response = await conn.request(`/acc.cgi?acc=${accession}&targ=self&form=text&view=full`);
  if (typeof response !== 'string') {
    throw new Error(`${accession}: unexpected non-text response from GEO SOFT endpoint`);
  }
  if (response.trimStart().startsWith('<')) {
    throw new Error(
      `${accession}: GEO returned an HTML page instead of a SOFT record — GEO access is being blocked for this connection (NCBI serves block pages to some datacenter IPs). Retry later or run from a different network.`
    );
  }
  return assertEutilsText(response, `GEO ${accession}`);
}

async function fetchSoftRecord(accession: string): Promise<SoftRecord> {
  const record = parseSoftRecord(await fetchSoftText(accession));
  if (!record.accession) {
    throw new Error(`${accession}: GEO returned an unexpected SOFT response (no ^ENTITY header)`);
  }
  return record;
}

async function fetchGdsEnrichment(accession: string): Promise<GdsEnrichment | null> {
  try {
    const uid = await esearchGdsUid(accession);
    if (!uid) return null;
    const entry = (await esummaryGdsEntries([uid])).get(uid);
    if (!entry) return null;
    const samples = entry.samples ?? [];
    return {
      nSamples: entry.n_samples ?? samples.length,
      samplePreview: samples.slice(0, GEO_SAMPLES_PREVIEW).map(s => ({
        accession: s.accession ?? '',
        title: s.title,
      })),
      pdat: entry.pdat,
      taxon: entry.taxon,
      bioproject: entry.bioproject,
      pubmedIds: entry.pubmedids,
      sraTokens: entry.extrelations
        ?.filter(rel => rel.relationtype === 'SRA')
        .map(rel => rel.targetobject)
        .filter((t): t is string => !!t),
    };
  } catch {
    return null; // SOFT-only degradation — enrichment is best-effort
  }
}

/** 'First,MI,Last' SOFT contributor triples → 'First Last' display names. */
function formatContributor(value: string): string {
  const parts = value.split(',').map(p => p.trim());
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1];
  return [first, last].filter(p => p.length > 0).join(' ');
}

function extractSraTokens(relations: string[]): string[] {
  const tokens: string[] = [];
  for (const relation of relations) {
    if (!/\bSRA\s*:/i.test(relation)) continue;
    tokens.push(...(relation.match(SRA_TOKEN_REGEX) ?? []));
  }
  return [...new Set(tokens)];
}

function collectSeriesRelations(relations: string[], pattern: RegExp): string[] {
  const out: string[] = [];
  for (const relation of relations) {
    for (const match of relation.matchAll(pattern)) out.push(match[1].toUpperCase());
  }
  return [...new Set(out)];
}

function extractBioproject(relations: string[]): string | undefined {
  for (const relation of relations) {
    if (!/BioProject\s*:/i.test(relation)) continue;
    const match = BIOPROJECT_TOKEN_REGEX.exec(relation);
    if (match) return match[0];
  }
  return undefined;
}

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** '!Series_status = Public on Sep 15 2021' → '2021-09-15'. */
function parseStatusDate(status?: string): string | undefined {
  if (!status) return undefined;
  const match = /(?:Public|Private) on ([A-Z][a-z]{2}) (\d{1,2}) (\d{4})/.exec(status);
  if (!match) return undefined;
  const month = MONTHS[match[1]];
  if (!month) return undefined;
  return `${match[3]}-${month}-${match[2].padStart(2, '0')}`;
}

function filterSupplementaryFiles(values: string[]): string[] {
  return values.filter(v => v.length > 0 && !/^none$/i.test(v));
}

/** SOFT relation keys are '<Entity>_relation' with title-case entity names. */
function recordRelations(record: SoftRecord): string[] {
  const entity = record.entity_type;
  const key = entity.charAt(0) + entity.slice(1).toLowerCase() + '_relation';
  return getSoftValues(record, key);
}

function pickDownloadableFile(files: string[]): string | undefined {
  return files.find(f => /\.(gz|csv|txt)$/i.test(f)) ?? files[0];
}

async function downloadSupplementaryFile(
  url: string,
  maxBytes: number
): Promise<GeoDownloadedFile> {
  // GEO FTP URLs are served verbatim over HTTPS.
  const httpsUrl = url.replace(/^ftp:\/\//i, 'https://');
  const response = await fetch(httpsUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${httpsUrl}: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(
      `Supplementary file ${httpsUrl} is ${contentLength} bytes, exceeding the ${maxBytes} byte cap. Raise maxBytes or download manually.`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `Supplementary file ${httpsUrl} is ${buffer.byteLength} bytes, exceeding the ${maxBytes} byte cap. Raise maxBytes or download manually.`
    );
  }

  const filename = httpsUrl.split('/').pop() ?? 'geo_supplementary_file';
  const tmpDir = mkdtempSync(join(tmpdir(), 'geo_'));
  const path = join(tmpDir, filename);
  writeFileSync(path, buffer);

  return { path, size_bytes: buffer.byteLength, filename, url: httpsUrl };
}

async function attachDownload(
  detail: GeoDetail,
  accession: string,
  options: GeoGetOptions
): Promise<GeoDetail> {
  if (!options.download) return detail;
  const files = detail.supplementary_files;
  if (files.length === 0) {
    throw new Error(`No supplementary file available for ${accession}`);
  }
  const maxBytes = Math.max(options.maxBytes ?? GEO_DEFAULT_MAX_BYTES, GEO_MIN_MAX_BYTES);
  detail.download = await downloadSupplementaryFile(pickDownloadableFile(files)!, maxBytes);
  return detail;
}

export async function geoGet(accession: string, options: GeoGetOptions = {}): Promise<GeoDetail> {
  const normalized = validateGeoAccession(accession);
  const record = await fetchSoftRecord(normalized);

  let detail: GeoDetail;
  if (record.entity_type === 'SERIES') {
    detail = await buildSeriesDetail(normalized, record);
  } else if (record.entity_type === 'SAMPLE') {
    detail = buildSampleDetail(normalized, record);
  } else {
    detail = buildPlatformDetail(normalized, record);
  }

  return attachDownload(detail, normalized, options);
}

async function buildSeriesDetail(accession: string, record: SoftRecord): Promise<GeoSeriesDetail> {
  const relations = getSoftValues(record, 'Series_relation');
  const softSampleIds = getSoftValues(record, 'Series_sample_id');
  const enrichment = await fetchGdsEnrichment(accession);

  const samplePreview = enrichment?.samplePreview
    ?? softSampleIds.slice(0, GEO_SAMPLES_PREVIEW).map(id => ({ accession: id, title: undefined }));

  const pubmedIds = [
    ...new Set([
      ...getSoftValues(record, 'Series_pubmed_id').map(Number).filter(Number.isInteger),
      ...(enrichment?.pubmedIds ?? []),
    ]),
  ];

  const organisms = [
    ...new Set(
      [
        enrichment?.taxon,
        // Series SOFT emits 'Series_sample_organism'/'Series_platform_organism'
        // (no _ch1 suffix, unlike sample records).
        ...getSoftValues(record, 'Series_organism_ch1'),
        ...getSoftValues(record, 'Series_sample_organism_ch1'),
        ...getSoftValues(record, 'Series_sample_organism'),
        ...getSoftValues(record, 'Series_platform_organism'),
      ].filter((o): o is string => !!o)
    ),
  ];

  return {
    accession,
    entry_type: 'series',
    title: getSoftValue(record, 'Series_title') ?? '',
    status: getSoftValue(record, 'Series_status'),
    submission_date: getSoftValue(record, 'Series_submission_date'),
    last_update_date: getSoftValue(record, 'Series_last_update_date'),
    publication_date: enrichment?.pdat ?? parseStatusDate(getSoftValue(record, 'Series_status')),
    type: getSoftValue(record, 'Series_type'),
    overall_design: getSoftValue(record, 'Series_overall_design'),
    summary: getSoftValue(record, 'Series_summary'),
    organisms,
    contributor_names: getSoftValues(record, 'Series_contributor').map(formatContributor),
    platform_ids: getSoftValues(record, 'Series_platform_id').map(p => p.toUpperCase()),
    supplementary_files: filterSupplementaryFiles(getSoftValues(record, 'Series_supplementary_file')),
    samples: samplePreview,
    n_samples: enrichment?.nSamples ?? softSampleIds.length,
    pubmed_ids: pubmedIds,
    bioproject: extractBioproject(relations) ?? enrichment?.bioproject,
    sra: [...new Set([...extractSraTokens(relations), ...(enrichment?.sraTokens ?? [])])],
    super_series: collectSeriesRelations(relations, /SuperSeries of (GSE\d+)/gi),
    sub_series: collectSeriesRelations(relations, /SubSeries of (GSE\d+)/gi),
    relations_raw: relations,
  };
}

function buildSampleDetail(accession: string, record: SoftRecord): GeoSampleDetail {
  const relations = getSoftValues(record, 'Sample_relation');
  const seriesId = getSoftValue(record, 'Sample_series_id')
    ?? relations.map(r => /\bGSE\d+\b/.exec(r)?.[0]).find(Boolean);

  return {
    accession,
    entry_type: 'sample',
    title: getSoftValue(record, 'Sample_title') ?? '',
    status: getSoftValue(record, 'Sample_status'),
    source_name: getSoftValue(record, 'Sample_source_name_ch1'),
    organism: getSoftValue(record, 'Sample_organism_ch1'),
    characteristics: getSoftValues(record, 'Sample_characteristics_ch1'),
    platform_id: getSoftValue(record, 'Sample_platform_id')?.toUpperCase(),
    supplementary_files: filterSupplementaryFiles(getSoftValues(record, 'Sample_supplementary_file')),
    series: seriesId?.toUpperCase(),
    sra: extractSraTokens(relations),
    relations_raw: relations,
  };
}

function buildPlatformDetail(accession: string, record: SoftRecord): GeoPlatformDetail {
  const relations = getSoftValues(record, 'Platform_relation');
  return {
    accession,
    entry_type: 'platform',
    title: getSoftValue(record, 'Platform_title') ?? '',
    status: getSoftValue(record, 'Platform_status'),
    technology: getSoftValue(record, 'Platform_technology'),
    organisms: [...new Set(getSoftValues(record, 'Platform_organism_ch1'))],
    supplementary_files: filterSupplementaryFiles(getSoftValues(record, 'Platform_supplementary_file')),
    relations_raw: relations,
    sra: extractSraTokens(relations),
  };
}

export async function geoToSraAccessions(accession: string): Promise<string[]> {
  const normalized = validateGeoAccession(accession);

  // Primary: SRA-tagged relations in the SOFT record.
  try {
    const record = await fetchSoftRecord(normalized);
    const tokens = extractSraTokens(recordRelations(record));
    if (tokens.length > 0) return tokens;
  } catch {
    // GEO SOFT unavailable — fall through to E-utilities paths.
  }

  // Secondary: esummary gds extrelations (requires the gds UID).
  let uid: string | undefined;
  try {
    uid = await esearchGdsUid(normalized);
  } catch {
    return [];
  }
  if (!uid) return [];
  try {
    const entry = (await esummaryGdsEntries([uid])).get(uid);
    const extTokens = entry?.extrelations
      ?.filter(rel => rel.relationtype === 'SRA')
      .map(rel => rel.targetobject)
      .filter((t): t is string => !!t && /^SR[PRSX]\d+$/.test(t))
      ?? [];
    if (extTokens.length > 0) return [...new Set(extTokens)];
  } catch {
    // fall through to elink
  }

  // Last resort: elink gds→sra yields run-level numeric UIDs, not
  // accessions — never fabricate accessions from them.
  try {
    const parsed = await eutilsJson<ElinkResponse>(
      `/elink.fcgi?dbfrom=gds&db=sra&id=${uid}&retmode=json`,
      'GEO to SRA link'
    );
    const links = (parsed.linksets ?? []).flatMap(ls => ls.linksetdbs ?? [])
      .flatMap(db => db.links ?? []);
    return [...new Set(links.filter(l => /^SR[PRSX]\d+$/.test(l)))];
  } catch {
    return [];
  }
}

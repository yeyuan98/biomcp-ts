import { ppubsClient } from '../ppubs-client.js';
import type { PatentSearchOptions, PatentSearchResult, PatentStatus } from '../types.js';

interface PpubsRecord {
  guid?: string;
  inventionTitle?: string;
  publicationReferenceDocumentNumber?: string;
  datePublished?: string;
  type?: string;
  applicantName?: string[] | null;
  assigneeName?: string[] | null;
  cpcInventiveFlattened?: string | null;
  ipcCodeFlattened?: string | null;
  applicationFilingDate?: string[];
  /** Solr relevance score, present when sorted with `score desc`. */
  score?: number | null;
}

function firstDate(v: string[] | undefined): string | undefined {
  if (!v || v.length === 0) return undefined;
  const raw = v[0];
  return raw.slice(0, 10);
}

export function transformPpubsResult(record: PpubsRecord): PatentSearchResult {
  const number = (record.publicationReferenceDocumentNumber || '').replace(/^US/, '');
  const kind = record.guid ? record.guid.split('-').pop() || '' : '';
  const isGrant = record.type === 'USPAT';
  const status: PatentStatus = isGrant ? 'granted' : 'application';

  // Applications have assigneeName null; fall back to applicantName.
  const org = record.assigneeName?.filter(Boolean) || record.applicantName?.filter(Boolean) || [];

  const cpc = (record.cpcInventiveFlattened || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  return {
    publication_number: `US${number}${kind}`,
    title: record.inventionTitle,
    publication_date: record.datePublished ? record.datePublished.slice(0, 10) : undefined,
    filing_date: firstDate(record.applicationFilingDate),
    assignee: org.length > 0 ? org : undefined,
    applicant: record.applicantName?.filter(Boolean).length ? record.applicantName!.filter(Boolean) : undefined,
    cpc_codes: cpc.length > 0 ? cpc.slice(0, 10) : undefined,
    status,
    relevance_score: typeof record.score === 'number' ? record.score : undefined,
    source: 'ppubs',
  };
}

function buildPpubsQuery(query: string, options: PatentSearchOptions): string {
  const parts: string[] = [];
  if (query.trim()) parts.push(query.trim());
  if (options.assignee) parts.push(`(${options.assignee}).as.`);
  if (options.inventor) parts.push(`(${options.inventor}).in.`);
  if (options.cpc) parts.push(`(${options.cpc}).cpc.`);
  if (options.date_range) {
    const [from, to] = options.date_range.split('/').map(s => (s || '').replace(/-/g, ''));
    let dateExpr = '';
    if (from && to) dateExpr = `@pd>=${from}<=${to}`;
    else if (from) dateExpr = `@pd>=${from}`;
    else if (to) dateExpr = `@pd<=${to}`;
    if (dateExpr) parts.push(dateExpr);
  }
  return parts.length > 0 ? parts.join(' AND ') : 'biomedical';
}

function databasesFor(status?: PatentStatus): string[] {
  if (status === 'granted') return ['USPAT', 'USOCR'];
  if (status === 'application') return ['US-PGPUB'];
  return ['US-PGPUB', 'USPAT', 'USOCR'];
}

export async function searchPpubs(
  query: string,
  options: PatentSearchOptions = {}
): Promise<{ patents: PatentSearchResult[]; total?: number }> {
  const q = buildPpubsQuery(query, options);
  const relevance = (options.sort_by ?? 'relevance') === 'relevance';
  const limit = options.limit ?? 10;
  const offset = options.offset ?? 0;

  // Verified upstream behavior: under `score desc` the server returns one
  // bounded top-N batch and ignores `start` (the webapp pages client-side),
  // so relevance mode always fetches from 0 and slices [offset, offset+limit)
  // locally. Recency mode keeps server-side `start` paging.
  const resp = relevance
    ? await ppubsClient.search(q, {
        start: 0,
        pageCount: Math.min(offset + limit, 100),
        databases: databasesFor(options.status),
        sort: 'score desc',
      })
    : await ppubsClient.search(q, {
        start: offset,
        pageCount: limit,
        databases: databasesFor(options.status),
        sort: 'date_publ desc',
      });

  if (resp.status !== 200) {
    throw new Error(`USPTO Public Search failed: HTTP ${resp.status} ${resp.body.slice(0, 200)}`);
  }

  let parsed: { patents?: PpubsRecord[]; totalResults?: number; numFound?: number; numberOfFamilies?: number };
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    throw new Error('USPTO Public Search returned malformed JSON.');
  }

  let records = parsed.patents || [];
  if (relevance) {
    records = records.slice(offset, offset + limit);
  }
  // numberOfFamilies is the stable match count; totalResults/numFound are
  // window sizes that vary with sort mode.
  return {
    patents: records.map(transformPpubsResult),
    total: parsed.numberOfFamilies ?? parsed.totalResults ?? parsed.numFound,
  };
}

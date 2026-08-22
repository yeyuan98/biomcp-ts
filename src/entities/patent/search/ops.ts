import { opsClient, hasOpsCredentials } from '../ops-client.js';
import type { PatentSearchOptions, PatentSearchResult } from '../types.js';
import { kindToStatus } from './dedup.js';

function asArray<T>(x: T | T[] | undefined | null): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function textOf(x: unknown): string | undefined {
  if (x && typeof x === 'object' && '$' in (x as Record<string, unknown>)) {
    return String((x as Record<string, unknown>)['$']);
  }
  return typeof x === 'string' ? x : undefined;
}

interface BadgerFish {
  [key: string]: unknown;
}

function escapeCql(s: string): string {
  return s.replace(/"/g, '');
}

function buildCql(query: string, options: PatentSearchOptions): string {
  const parts: string[] = [];
  if (query.trim()) {
    const q = escapeCql(query.trim());
    parts.push(`(ti="${q}" OR ab="${q}")`);
  }
  if (options.assignee) {
    parts.push(`pa="${escapeCql(options.assignee)}"`);
  }
  if (options.inventor) {
    parts.push(`in="${escapeCql(options.inventor)}"`);
  }
  if (options.cpc) {
    parts.push(`cpc=${escapeCql(options.cpc)}`);
  }
  if (parts.length === 0) {
    return 'ti="biomedical"';
  }
  return parts.join(' AND ');
}

function pickEnglish(items: BadgerFish[]): BadgerFish | undefined {
  return items.find(i => i['@lang'] === 'en') || items[0];
}

export function transformOpsSearchHit(doc: BadgerFish): PatentSearchResult {
  const bib = (doc['bibliographic-data'] || {}) as BadgerFish;
  const country = textOf(doc['@country']) || '';
  const docNumber = textOf(doc['@doc-number']) || '';
  const kind = textOf(doc['@kind']) || '';

  const titles = asArray(bib['invention-title'] as BadgerFish[]);
  const title = textOf(pickEnglish(titles));

  const parties = (bib['parties'] || {}) as BadgerFish;
  const applicants = asArray((parties['applicants'] as BadgerFish)?.['applicant'] as BadgerFish[])
    .map(a => textOf((a['applicant-name'] as BadgerFish)?.['name']))
    .filter((x): x is string => !!x);
  const inventors = asArray((parties['inventors'] as BadgerFish)?.['inventor'] as BadgerFish[])
    .map(i => textOf((i['inventor-name'] as BadgerFish)?.['name']))
    .filter((x): x is string => !!x);

  const pubRefs = asArray((bib['publication-reference'] as BadgerFish)?.['document-id'] as BadgerFish[]);
  let publicationDate: string | undefined;
  for (const ref of pubRefs) {
    if (ref['@document-id-type'] === 'docdb') {
      const d = textOf(ref['date']);
      if (d) {
        publicationDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        break;
      }
    }
  }

  const appRefs = asArray((bib['application-reference'] as BadgerFish)?.['document-id'] as BadgerFish[]);
  let filingDate: string | undefined;
  for (const ref of appRefs) {
    const d = textOf(ref['date']);
    if (d) {
      filingDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      break;
    }
  }

  const priorityClaims = asArray((bib['priority-claims'] as BadgerFish)?.['priority-claim'] as BadgerFish[]);
  let priorityDate: string | undefined;
  for (const pc of priorityClaims) {
    for (const ref of asArray(pc['document-id'] as BadgerFish[])) {
      const d = textOf(ref['date']);
      if (d) {
        priorityDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        break;
      }
    }
    if (priorityDate) break;
  }

  const cpc = new Set<string>();
  const classifications = asArray((bib['patent-classifications'] as BadgerFish)?.['patent-classification'] as BadgerFish[]);
  for (const c of classifications) {
    const section = textOf(c['section']);
    const cls = textOf(c['class']);
    const subclass = textOf(c['subclass']);
    const mainGroup = textOf(c['main-group']);
    const subGroup = textOf(c['subgroup']);
    if (section && cls && subclass) {
      const mg = (mainGroup || '0').replace(/\s+/g, '');
      const sg = (subGroup || '0').replace(/\s+/g, '');
      cpc.add(`${section}${cls}${subclass}${mg}/${sg}`);
    }
  }

  const status = kindToStatus(kind);

  return {
    publication_number: `${country}${docNumber}${kind}`,
    title,
    publication_date: publicationDate,
    filing_date: filingDate,
    priority_date: priorityDate,
    assignee: applicants.length > 0 ? applicants : undefined,
    applicant: applicants.length > 0 ? applicants : undefined,
    inventor: inventors.length > 0 ? inventors : undefined,
    cpc_codes: cpc.size > 0 ? Array.from(cpc).slice(0, 10) : undefined,
    status,
    source: 'ops',
  };
}

export async function searchOps(
  query: string,
  options: PatentSearchOptions = {}
): Promise<{ patents: PatentSearchResult[]; total?: number }> {
  if (!hasOpsCredentials()) {
    throw new Error('EPO OPS credentials not configured. Set EPO_OPS_CONSUMER_KEY and EPO_OPS_CONSUMER_SECRET environment variables.');
  }

  const limit = Math.min(options.limit ?? 10, 100);
  const offset = options.offset ?? 0;
  if (offset + limit > 2000) {
    throw new Error('EPO OPS caps reachable results at 2000; reduce offset.');
  }
  const begin = offset + 1;
  const end = offset + limit;
  const cql = buildCql(query, options);
  const path = `/published-data/search/biblio?q=${encodeURIComponent(cql)}&Range=${begin}-${end}`;

  const resp = await opsClient.get(path);
  if (resp.status !== 200) {
    throw new Error(`EPO OPS search failed: HTTP ${resp.status} ${resp.body.slice(0, 200)}`);
  }

  let parsed: BadgerFish;
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    throw new Error('EPO OPS search returned malformed JSON.');
  }

  const world = (parsed['ops:world-patent-data'] || {}) as BadgerFish;
  const biblioSearch = (world['ops:biblio-search'] || {}) as BadgerFish;
  const total = Number(biblioSearch['@total-result-count']) || undefined;
  const searchResult = (biblioSearch['ops:search-result'] || {}) as BadgerFish;
  const exchangeDocs = (searchResult['exchange-documents'] || {}) as BadgerFish;
  const docs = asArray(exchangeDocs['exchange-document'] as BadgerFish[]);

  let patents = docs.map(transformOpsSearchHit);

  // OPS CQL has no reliable date-range or kind-code filters (verified: `pd
  // within` 500s server-side), so narrow client-side when requested.
  let filteredTotal = total;
  if (options.date_range) {
    const [from, to] = options.date_range.split('/');
    patents = patents.filter(p => {
      const d = p.publication_date;
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    filteredTotal = undefined;
  }
  if (options.status) {
    patents = patents.filter(p => p.status === options.status);
    filteredTotal = undefined;
  }

  return { patents, total: filteredTotal };
}

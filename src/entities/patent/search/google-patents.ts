import { connectionManager } from '../../../connections/manager.js';
import type { PatentSearchOptions, PatentSearchResult } from '../types.js';

const BREAKER_OPEN_MS = 30 * 60 * 1000;
const BLOCK_SIGNATURES = ['Sorry...', 'automated queries', '/sorry/'];

interface BreakerState {
  openedAt: number;
}

let breaker: BreakerState | null = null;

export function isGooglePatentsBlocked(): boolean {
  return breaker !== null && Date.now() - breaker.openedAt < BREAKER_OPEN_MS;
}

export function resetGooglePatentsBreaker(): void {
  breaker = null;
}

function tripBreaker(): void {
  breaker = { openedAt: Date.now() };
}

function stripHtml(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

interface GpPatent {
  title?: string;
  snippet?: string;
  priority_date?: string;
  filing_date?: string;
  publication_date?: string;
  inventor?: string[];
  assignee?: string[];
  publication_number?: string;
  language?: string;
}

interface GpResponse {
  results?: {
    total_num_results?: number;
    cluster?: Array<{ result?: Array<{ id?: string; patent?: GpPatent }> }>;
  };
}

export function transformGooglePatentsResult(p: GpPatent): PatentSearchResult {
  const pubNum = (p.publication_number || '').replace(/\s+/g, '');
  // Kind heuristics: B*=granted, A*=application for the major authorities.
  const kindMatch = pubNum.match(/[A-Z]\d?$/);
  const status = kindMatch && /^B/.test(kindMatch[0]) ? 'granted' : 'application';
  return {
    publication_number: pubNum,
    title: stripHtml(p.title),
    snippet: stripHtml(p.snippet),
    publication_date: p.publication_date,
    filing_date: p.filing_date,
    priority_date: p.priority_date,
    assignee: p.assignee && p.assignee.length > 0 ? p.assignee : undefined,
    inventor: p.inventor && p.inventor.length > 0 ? p.inventor : undefined,
    status,
    language: p.language,
    source: 'google_patents',
  };
}

function buildInnerUrl(query: string, options: PatentSearchOptions): string {
  const params = new URLSearchParams();
  // Multi-word free text must be quoted or Google applies OR semantics.
  params.set('q', `"${query.trim().replace(/"/g, '')}"`);
  params.set('num', String(Math.min(options.limit ?? 10, 50)));
  const offset = options.offset ?? 0;
  if (offset > 0) {
    params.set('page', String(Math.floor(offset / Math.min(options.limit ?? 10, 50))));
  }
  if (options.assignee) params.set('assignee', options.assignee);
  if (options.inventor) params.set('inventor', options.inventor);
  if (options.cpc) params.set('cpc', options.cpc);
  if (options.status === 'granted') params.set('type', 'PATENT');
  if (options.status === 'application') params.set('type', 'APPLICATION');
  if (options.date_range) {
    const [from, to] = options.date_range.split('/');
    if (from) params.set('after', `priority:${from.replace(/-/g, '')}`);
    if (to) params.set('before', `priority:${to.replace(/-/g, '')}`);
  }
  return params.toString();
}

export async function searchGooglePatents(
  query: string,
  options: PatentSearchOptions = {}
): Promise<{ patents: PatentSearchResult[]; total?: number }> {
  if (isGooglePatentsBlocked()) {
    throw new Error('Google Patents is temporarily unavailable (rate-limit block detected). Try EPO OPS (ops), USPTO ODP (uspto_odp), or PPUBS (ppubs) sources instead.');
  }

  const conn = connectionManager.getConnection('google_patents');
  const inner = buildInnerUrl(query, options);
  const path = `/xhr/query?url=${encodeURIComponent(inner)}`;

  let raw: unknown;
  try {
    raw = await conn.request(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HTTP 503') || msg.includes('HTTP 429')) {
      tripBreaker();
    }
    throw err;
  }

  const data = raw as GpResponse;
  const results = data.results?.cluster?.[0]?.result || [];
  const patents = results
    .map(r => r.patent)
    .filter((p): p is GpPatent => !!p)
    .map(transformGooglePatentsResult);

  return { patents, total: data.results?.total_num_results };
}

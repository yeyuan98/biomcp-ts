import type { PatentSearchOptions, PatentSearchResponse, PatentSearchResult, PatentSource } from '../types.js';
import { hasOpsCredentials } from '../ops-client.js';
import { hasOdpKey } from './odp.js';
import { isGooglePatentsBlocked } from './google-patents.js';
import { dedupPatents } from './dedup.js';

export const PATENT_SEARCH_SOURCES: readonly PatentSource[] = ['ops', 'uspto_odp', 'ppubs', 'google_patents'] as const;

/** Skip the ppubs→odp fallback when the tool timeout budget is nearly spent. */
const FALLBACK_BUDGET_MS = 12_000;

const EMPTY_HINT =
  'No patents matched. Try quoting an exact concept phrase (e.g. "mRNA display"), broadening terms, ' +
  'or use source "ppubs" for US full-text search.';

const WINDOW_HINT =
  'This page is beyond the bounded relevance window (relevance ranking returns a top-N batch per query). ' +
  'Use a smaller offset or sort_by "recency" for deep pagination.';

/**
 * Documented counting basis per backend (surfaced as total_hits_basis).
 * ppubs counts US document families; ODP counts US applications (bibliographic);
 * OPS counts worldwide matches capped at 10000; Google Patents is approximate.
 */
export const TOTAL_HITS_BASIS: Record<PatentSource, string> = {
  ppubs: 'matching US document families',
  uspto_odp: 'matching US applications (bibliographic)',
  ops: 'worldwide matches, capped at 10000',
  google_patents: 'approximate',
};

/**
 * Select backends for a federated query:
 * - worldwide: EPO OPS when credentials exist; otherwise Google Patents
 *   (best-effort, circuit-breaker gated)
 * - US: PPUBS always — keyless, full-text, relevance-ranked. USPTO ODP is
 *   bibliographic (file-wrapper metadata) and therefore opt-in via `source`.
 */
export function selectSearchBackends(options: PatentSearchOptions): PatentSource[] {
  if (options.source) return [options.source];
  const worldwide: PatentSource[] = hasOpsCredentials()
    ? ['ops']
    : (!isGooglePatentsBlocked() ? ['google_patents'] : []);
  return [...worldwide, 'ppubs'];
}

/**
 * Order federated results by relevance when any backend supplied scores:
 * scored results first (score desc, stable), unscored backends after.
 */
export function orderFederatedByRelevance(patents: PatentSearchResult[]): PatentSearchResult[] {
  if (!patents.some(p => typeof p.relevance_score === 'number')) return patents;
  const scored = patents.filter(p => typeof p.relevance_score === 'number');
  const unscored = patents.filter(p => typeof p.relevance_score !== 'number');
  scored.sort((a, b) => (b.relevance_score as number) - (a.relevance_score as number));
  return [...scored, ...unscored];
}

async function runBackend(
  source: PatentSource,
  query: string,
  options: PatentSearchOptions
): Promise<{ patents: PatentSearchResult[]; total?: number; error?: string }> {
  switch (source) {
    case 'ops': {
      const { searchOps } = await import('./ops.js');
      return searchOps(query, options);
    }
    case 'uspto_odp': {
      const { searchOdp } = await import('./odp.js');
      return searchOdp(query, options);
    }
    case 'ppubs': {
      const { searchPpubs } = await import('./ppubs.js');
      return searchPpubs(query, options);
    }
    case 'google_patents': {
      const { searchGooglePatents } = await import('./google-patents.js');
      return searchGooglePatents(query, options);
    }
  }
}

/**
 * Federated patent search. Without an explicit `source`, queries the
 * auto-selected worldwide + US (ppubs) backends concurrently and deduplicates
 * by publication number. A failed backend appends a `{ _error }` marker
 * element instead of failing the whole search; when the default ppubs backend
 * fails hard and a USPTO ODP key exists, one budget-guarded fallback retry
 * runs on ODP and its results are tagged with a `{ _note }` provenance
 * marker. Marker elements (_error/_note/_hint) never count toward `limit`.
 * A clean 0-hit search appends a `{ _hint }` with refinement guidance.
 */
export async function patentSearch(
  query: string,
  options: PatentSearchOptions = {}
): Promise<PatentSearchResponse> {
  const startedAt = Date.now();
  const backends = selectSearchBackends(options);

  const settled = await Promise.allSettled(
    backends.map(source => runBackend(source, query, options)),
  );

  const collected: PatentSearchResult[] = [];
  const total_hits: PatentSearchResponse['total_hits'] = {};
  const errors: Array<{ source: PatentSource; message: string }> = [];
  const notes: Array<{ source: PatentSource; message: string }> = [];

  const record = (source: PatentSource, value: { patents: PatentSearchResult[]; total?: number }) => {
    collected.push(...value.patents);
    if (value.total !== undefined) {
      total_hits[source] = value.total;
    }
  };

  for (let i = 0; i < settled.length; i++) {
    const source = backends[i];
    const result = settled[i];
    if (result.status === 'fulfilled') {
      record(source, result.value);
      continue;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);

    // Failure-only fallback (never on 0 hits — those are legitimate
    // results): default ppubs → uspto_odp, once, budget-guarded. Explicit
    // `source` requests are respected as-is.
    if (source === 'ppubs' && !options.source && hasOdpKey() && Date.now() - startedAt <= FALLBACK_BUDGET_MS) {
      try {
        const fallback = await runBackend('uspto_odp', query, options);
        record('uspto_odp', fallback);
        notes.push({
          source: 'ppubs',
          message: `Search on source 'ppubs' failed: ${message}`,
        });
        continue;
      } catch {
        // fall through to the error marker below
      }
    }
    errors.push({ source, message });
  }

  const limit = options.limit ?? 10;
  const ordered = orderFederatedByRelevance(dedupPatents(collected));
  const patents: PatentSearchResult[] = ordered.slice(0, limit);

  for (const { source, message } of notes) {
    const visible = patents.some(
      p => p.source === 'uspto_odp' || p.also_found_in?.includes('uspto_odp'),
    );
    const suffix = visible
      ? 'showing uspto_odp fallback results.'
      : 'uspto_odp fallback results did not fit on this page (check total_hits).';
    patents.push({ publication_number: '', _note: `${message}; ${suffix}`, source });
  }
  for (const { source, message } of errors) {
    patents.push({ publication_number: '', _error: `Search on source '${source}' failed: ${message}`, source });
  }
  if (collected.length === 0 && errors.length === 0 && notes.length === 0) {
    const someMatches = Object.values(total_hits).some(t => (t ?? 0) > 0);
    const hintSource = backends.includes('ppubs') ? 'ppubs' : backends[0];
    patents.push({ publication_number: '', _hint: someMatches ? WINDOW_HINT : EMPTY_HINT, source: hintSource });
  }

  const total_hits_basis: PatentSearchResponse['total_hits_basis'] = {};
  for (const source of Object.keys(total_hits) as PatentSource[]) {
    total_hits_basis[source] = TOTAL_HITS_BASIS[source];
  }

  return { patents, total_hits, total_hits_basis };
}

export { dedupPatents, normalizePublicationNumber, isValidPublicationNumber } from './dedup.js';
export { transformGooglePatentsResult, isGooglePatentsBlocked } from './google-patents.js';
export { transformPpubsResult } from './ppubs.js';
export { transformOpsSearchHit } from './ops.js';
export { transformOdpWrapper } from './odp.js';

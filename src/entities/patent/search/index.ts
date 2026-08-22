import type { PatentSearchOptions, PatentSearchResponse, PatentSearchResult, PatentSource } from '../types.js';
import { hasOpsCredentials } from '../ops-client.js';
import { hasOdpKey } from './odp.js';
import { isGooglePatentsBlocked } from './google-patents.js';
import { dedupPatents } from './dedup.js';

export const PATENT_SEARCH_SOURCES: readonly PatentSource[] = ['ops', 'uspto_odp', 'ppubs', 'google_patents'] as const;

/**
 * Select backends for a federated query:
 * - worldwide: EPO OPS when credentials exist; otherwise Google Patents
 *   (best-effort, circuit-breaker gated)
 * - US: USPTO ODP when the API key exists; otherwise keyless PPUBS
 */
export function selectSearchBackends(options: PatentSearchOptions): PatentSource[] {
  if (options.source) return [options.source];
  const worldwide: PatentSource[] = hasOpsCredentials()
    ? ['ops']
    : (!isGooglePatentsBlocked() ? ['google_patents'] : []);
  const us: PatentSource[] = hasOdpKey() ? ['uspto_odp'] : ['ppubs'];
  return [...worldwide, ...us];
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
 * auto-selected worldwide + US backends concurrently and deduplicates by
 * publication number. A failed backend appends a `{ _error }` marker element
 * instead of failing the whole search.
 */
export async function patentSearch(
  query: string,
  options: PatentSearchOptions = {}
): Promise<PatentSearchResponse> {
  const backends = selectSearchBackends(options);

  const settled = await Promise.allSettled(
    backends.map(source => runBackend(source, query, options)),
  );

  const collected: PatentSearchResult[] = [];
  const total_hits: PatentSearchResponse['total_hits'] = {};
  const errors: Array<{ source: PatentSource; message: string }> = [];

  settled.forEach((result, i) => {
    const source = backends[i];
    if (result.status === 'fulfilled') {
      collected.push(...result.value.patents);
      if (result.value.total !== undefined) {
        total_hits[source] = result.value.total;
      }
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ source, message });
    }
  });

  const patents: PatentSearchResult[] = dedupPatents(collected);
  for (const { source, message } of errors) {
    patents.push({ _error: `Search on source '${source}' failed: ${message}`, source } as any);
  }

  return { patents, total_hits };
}

export { dedupPatents, normalizePublicationNumber, isValidPublicationNumber } from './dedup.js';
export { transformGooglePatentsResult, isGooglePatentsBlocked } from './google-patents.js';
export { transformPpubsResult } from './ppubs.js';
export { transformOpsSearchHit } from './ops.js';
export { transformOdpWrapper } from './odp.js';

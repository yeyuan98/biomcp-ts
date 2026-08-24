import type { PatentSearchOptions, PatentSearchResponse, PatentSearchResult, PatentSource } from '../types.js';
import { hasOpsCredentials, isOpsBackedOff, opsBackoffReason, recordOpsFailure, recordOpsSuccess } from '../ops-client.js';
import { hasOdpKey } from './odp.js';
import { isGooglePatentsBlocked } from './google-patents.js';
import { dedupPatents } from './dedup.js';

export const PATENT_SEARCH_SOURCES: readonly PatentSource[] = ['ops', 'uspto_odp', 'ppubs', 'google_patents'] as const;

/** Skip the ppubs→odp fallback when the tool timeout budget is nearly spent. */
const FALLBACK_BUDGET_MS = 12_000;

/**
 * Tool-level timeout budget for patent_search. Exported so server/tools
 * derives SEARCH_TIMEOUT_MS from it (no upward import) and the seminal
 * mining phase can adapt to elapsed time instead of assuming a fixed
 * budget — the fixed 20s deadline predated the 30s → 60s tool-timeout
 * bump and misreported rate-limiter pacing as "mining source
 * unavailable" (verified: batch auto-mode calls queue behind the shared
 * 1 req/s ppubs bucket; forced-source calls start mining with it full).
 */
export const PATENT_SEARCH_TOOL_BUDGET_MS = 60_000;

/** Reserved under the tool budget for response serialization/transport. */
const MINING_SAFETY_MARGIN_MS = 5_000;
/**
 * Below this remaining budget mining is skipped outright: the phase
 * needs ~11 paced ppubs calls (1 pool + 10 docs at 1 req/s), so a
 * shorter budget cannot finish and would risk the tool timeout
 * destroying the whole response — main results included.
 */
const MINING_MIN_BUDGET_MS = 8_000;

const EMPTY_HINT =
  'No patents matched. Try quoting an exact concept phrase (e.g. "mRNA display"), broadening terms, ' +
  'or use source "ppubs" for US full-text search.';

const WINDOW_HINT =
  'This page is beyond the bounded relevance window (relevance ranking returns a top-N batch per query). ' +
  'Use a smaller offset or sort_by "recency" for deep pagination.';

/**
 * Documented counting basis per backend (surfaced as total_hits_basis).
 * ppubs counts US document families; ODP counts US applications (bibliographic);
 * OPS counts worldwide matches but deep paging is capped at 2000, so matches
 * beyond that are unreachable; Google Patents is approximate.
 */
export const TOTAL_HITS_BASIS: Record<PatentSource, string> = {
  ppubs: 'matching US document families',
  uspto_odp: 'matching US applications (bibliographic)',
  ops: 'worldwide matches, deep paging capped at 2000 (matches beyond are unreachable)',
  google_patents: 'approximate',
};

/**
 * Select backends for a federated query:
 * - worldwide: EPO OPS when credentials exist and it is not in failure
 *   backoff (placeholder/expired creds burn a call every search otherwise);
 *   otherwise Google Patents (best-effort, circuit-breaker gated)
 * - US: PPUBS always — keyless, full-text, relevance-ranked. USPTO ODP is
 *   bibliographic (file-wrapper metadata) and therefore opt-in via `source`.
 */
export function selectSearchBackends(options: PatentSearchOptions): PatentSource[] {
  if (options.source) return [options.source];
  const worldwide: PatentSource[] = hasOpsCredentials() && !isOpsBackedOff()
    ? ['ops']
    : (!isGooglePatentsBlocked() ? ['google_patents'] : []);
  return [...worldwide, 'ppubs'];
}

/**
 * Human-readable explanation when auto mode has no worldwide backend left
 * (OPS unavailable AND Google Patents breaker open) — coverage silently
 * dropping to US-only is worse than an explicit note. Undefined when a
 * worldwide backend (or a substitute) is still selectable.
 */
export function worldwideCoverageNote(): string | undefined {
  if (hasOpsCredentials() && !isOpsBackedOff()) return undefined;
  if (!isGooglePatentsBlocked()) return undefined; // GP substitutes for OPS
  const reasons: string[] = [];
  if (hasOpsCredentials() && isOpsBackedOff()) {
    reasons.push(`ops excluded after repeated failures${opsBackoffReason() ? ` (${opsBackoffReason()})` : ''}`);
  } else if (!hasOpsCredentials()) {
    reasons.push('ops credentials not configured');
  }
  reasons.push('google_patents unreachable/blocked');
  return `worldwide coverage unavailable (${reasons.join('; ')}); results are US-only`;
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
      if (source === 'ops' && !options.source) recordOpsSuccess();
      continue;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    // Feed the auto-mode failure memory (explicit `source: 'ops'` attempts
    // always run and always report; only auto selection consults backoff).
    if (source === 'ops' && !options.source) recordOpsFailure(message);

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
  // Auto mode with no worldwide backend left (OPS backoff + GP breaker):
  // say so once instead of silently returning US-only results.
  if (!options.source) {
    const coverageNote = worldwideCoverageNote();
    if (coverageNote && !backends.includes('ops') && !backends.includes('google_patents')) {
      patents.push({ publication_number: '', _note: coverageNote, source: 'ppubs' });
    }
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

  // Foundational prior-art discovery via co-citation mining. Default-on
  // (opt out with seminal: false); runs only when real results exist and
  // degrades to a note on any failure — it must never break the search.
  // The budget adapts to elapsed time: elapsed is measured after the
  // fallback loop so a slow main search (or the shared ppubs rate limiter
  // draining under batch concurrency) shrinks — or skips — mining.
  const response: PatentSearchResponse = { patents, total_hits };
  if (total_hits_basis && Object.keys(total_hits_basis).length > 0) {
    response.total_hits_basis = total_hits_basis;
  }
  if (options.seminal ?? true) {
    const hasRealResults = patents.some(
      p => p.publication_number && !p._error && !p._note && !p._hint,
    );
    if (hasRealResults) {
      let seminal_note: string | undefined;
      const elapsed = Date.now() - startedAt;
      const remaining = PATENT_SEARCH_TOOL_BUDGET_MS - elapsed - MINING_SAFETY_MARGIN_MS;
      if (remaining < MINING_MIN_BUDGET_MS) {
        seminal_note = `seminal prior-art discovery skipped (time budget exhausted after a slow search; ${Math.round(elapsed / 1000)}s already spent)`;
      } else {
        try {
          const { mineSeminalPriorArt, SEMINAL_MAX_BUDGET_MS } = await import('./seminal.js');
          const outcome = await mineSeminalPriorArt(query, patents, Math.min(remaining, SEMINAL_MAX_BUDGET_MS));
          response.seminal_prior_art = outcome.entries;
          response.mined_count = outcome.mined;
          seminal_note = outcome.note;
        } catch (err) {
          // Never break the search — but do report the real cause (deadline,
          // PPUBS 5xx, malformed payload) instead of a constant string.
          seminal_note = `seminal prior-art discovery skipped (${err instanceof Error ? err.message : String(err)})`;
        }
      }
      if (!/"[^"]+"/.test(query) && query.trim().split(/\s+/).length > 1) {
        seminal_note = [
          seminal_note,
          'for more precise mining, quote an exact concept phrase (e.g. "mRNA display")',
        ].filter(Boolean).join('; ');
      }
      if (seminal_note) response.seminal_note = seminal_note;
    }
  }

  return response;
}

export { dedupPatents, normalizePublicationNumber, isValidPublicationNumber } from './dedup.js';
export { transformGooglePatentsResult, isGooglePatentsBlocked } from './google-patents.js';
export { transformPpubsResult } from './ppubs.js';
export { transformOpsSearchHit } from './ops.js';
export { transformOdpWrapper } from './odp.js';

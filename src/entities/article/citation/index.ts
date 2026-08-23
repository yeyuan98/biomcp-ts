import type { ArticleId, CitationRecord, CitationCount, SourceCitationResult, FederatedCitationResult } from './types.js';
import * as pubmedProvider from './pubmed.js';
import * as europepmcProvider from './europepmc.js';
import * as semanticScholarProvider from './semantic-scholar.js';
import * as crossrefProvider from './crossref.js';
import * as opencitationsProvider from './opencitations.js';
import { federatedCache, buildCacheKey } from './cache.js';

interface CitationProvider {
  sourceId: string;
  getForwardCitations: (id: ArticleId, limit: number) => Promise<CitationRecord[]>;
  getBackwardReferences: (id: ArticleId, limit: number, articleYear?: number) => Promise<CitationRecord[]>;
  getCitationCount: (id: ArticleId) => Promise<CitationCount | null>;
}

const ALL_PROVIDERS: CitationProvider[] = [
  { sourceId: 'pubmed', ...pubmedProvider },
  { sourceId: 'europepmc', ...europepmcProvider },
  { sourceId: 'semantic_scholar', ...semanticScholarProvider },
  { sourceId: 'crossref', ...crossrefProvider },
  { sourceId: 'opencitations', ...opencitationsProvider },
];

const FAST_PROVIDER_IDS = ['europepmc', 'semantic_scholar', 'crossref', 'opencitations'] as const;

/**
 * Computes a completeness score for a citation record based on available fields
 * @param record - Citation record to score
 * @returns Numerical score (higher = more complete)
 */
export function fieldScore(record: CitationRecord): number {
  let score = 0;
  if (record.doi) score += 1;
  if (record.pmid) score += 1;
  if (record.title) score += 2;
  if (record.authors && record.authors.length > 0) score += 2;
  if (record.journal) score += 1;
  if (record.year) score += 1;
  return score;
}

/**
 * Generates a unique key for a citation record based on available IDs
 * @param record - Citation record to key
 * @returns Unique key string or null if no IDs available
 */
export function recordKey(record: CitationRecord): string | null {
  if (record.doi) return `doi:${record.doi}`;
  if (record.pmid) return `pmid:${record.pmid}`;
  if (record.pmcid) return `pmcid:${record.pmcid}`;
  return null;
}

/**
 * Deduplicates citation records across multiple providers
 * @param records - Array of citation records from various sources
 * @returns Deduplicated array with highest-scoring record for each ID
 *
 * Uses a canonical key approach: each record is keyed by its first available
 * identifier (PMID > DOI > PMCID). This ensures each record appears only once
 * in the output, even if it has multiple identifier keys. When multiple records
 * share the same canonical key, the one with the highest fieldScore is kept.
 */
export function deduplicateRecords(records: CitationRecord[]): CitationRecord[] {
  const map = new Map<string, CitationRecord>();
  const keyless: CitationRecord[] = [];

  for (const record of records) {
    // Use canonical key: first available identifier (PMID > DOI > PMCID)
    // This ensures each record appears only once, regardless of multiple IDs
    const canonicalKey = record.pmid ? `pmid:${record.pmid}`
      : record.doi ? `doi:${record.doi}`
      : record.pmcid ? `pmcid:${record.pmcid}`
      : null;

    if (!canonicalKey) {
      keyless.push(record);
      continue;
    }

    const existing = map.get(canonicalKey);
    if (!existing || fieldScore(record) > fieldScore(existing)) {
      map.set(canonicalKey, record);
    }
  }

  return [...map.values(), ...keyless];
}

/**
 * Queries a single citation provider for citations, references, and counts
 * @param provider - Citation provider to query
 * @param id - Article identifier
 * @param direction - Citation direction(s) to fetch
 * @param limit - Maximum results per direction
 * @param articleYear - Optional publication year for filtering backward references
 * @returns Source citation result with data or error
 */
async function queryProvider(
  provider: CitationProvider,
  id: ArticleId,
  direction: 'forward' | 'backward' | 'both',
  limit: number,
  articleYear?: number
): Promise<SourceCitationResult> {
  const result: SourceCitationResult = {
    source_id: provider.sourceId,
    forward_citations: [],
    backward_references: [],
  };

  try {
    const tasks: Promise<unknown>[] = [];

    if (direction === 'forward' || direction === 'both') {
      tasks.push(
        provider.getForwardCitations(id, limit).then((citations) => {
          result.forward_citations = citations;
        })
      );
    }

    if (direction === 'backward' || direction === 'both') {
      tasks.push(
        provider.getBackwardReferences(id, limit, articleYear).then((refs) => {
          result.backward_references = refs;
        })
      );
    }

    tasks.push(
      provider.getCitationCount(id).then((count) => {
        result.citation_count = count ?? undefined;
      })
    );

    await Promise.all(tasks);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('429')) {
      console.warn(`[citation/${provider.sourceId}] Rate limited - using partial results`);
      result.error = `Rate limited by ${provider.sourceId}`;
    } else {
      console.error(`[citation/${provider.sourceId}] Error:`, error);
      result.error = msg;
    }
  }

  return result;
}

/**
 * Fetches citation data from multiple providers with caching and deduplication
 * @param id - Article identifier (PMID, PMCID, or DOI)
 * @param options - Query options (direction, source, limit, full mode, articleYear)
 * @returns Federated citation results with deduplicated data and provider status
 */
export async function getCitations(
  id: ArticleId,
  options?: {
    direction?: 'forward' | 'backward' | 'both';
    source?: string;
    limit?: number;
    full?: boolean;
    articleYear?: number;
  }
): Promise<FederatedCitationResult> {
  const direction = options?.direction ?? 'both';
  const limit = options?.limit ?? 50;
  const useFull = options?.full ?? false;
  const articleYear = options?.articleYear;

  const cacheKey = buildCacheKey(id, { direction, source: options?.source, full: useFull, articleYear });
  const cached = federatedCache.get<FederatedCitationResult>(cacheKey);
  if (cached) {
    // Ensure cached results have items_available field (for backward compatibility)
    if (typeof cached.items_available === 'undefined') {
      const hasItems = cached.forward_citations.length > 0 || cached.backward_references.length > 0;
      return { ...cached, items_available: hasItems };
    }
    return cached;
  }

  let sourceResults: SourceCitationResult[];
  let providers: CitationProvider[];

  if (options?.source) {
    const provider = ALL_PROVIDERS.find((p) => p.sourceId === options.source);
    if (!provider) {
      return {
        article_id: id,
        citation_counts: [],
        forward_citations: [],
        backward_references: [],
        source_results: [{
          source_id: options.source,
          forward_citations: [],
          backward_references: [],
          error: `Unknown citation source: ${options.source}`,
        }],
        items_available: false,
      };
    }
    providers = [provider];
  } else if (useFull) {
    providers = ALL_PROVIDERS;
  } else {
    providers = ALL_PROVIDERS.filter((p) => FAST_PROVIDER_IDS.includes(p.sourceId as typeof FAST_PROVIDER_IDS[number]));
  }

  const settled = await Promise.allSettled(
    providers.map((p) => queryProvider(p, id, direction, limit, articleYear))
  );

  sourceResults = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      source_id: providers[i].sourceId,
      forward_citations: [],
      backward_references: [],
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  const allForward = sourceResults.flatMap((r) => r.forward_citations);
  const allBackward = sourceResults.flatMap((r) => r.backward_references);
  const allCounts = sourceResults
    .map((r) => r.citation_count)
    .filter((c): c is CitationCount => c !== undefined);

  // Fast mode fallback: if we have counts but no items, try PubMed
  // Also triggers for direction="both" when we have backward items but no forward items
  let hasAnyItems = allForward.length > 0 || allBackward.length > 0;
  const hasCitationCounts = allCounts.length > 0;
  const needsForwardFallback = direction === 'both' && allBackward.length > 0 && allForward.length === 0;

  if (!useFull && !options?.source && id.pmid && (!hasAnyItems && hasCitationCounts || needsForwardFallback)) {
    const pubmedProvider = ALL_PROVIDERS.find((p) => p.sourceId === 'pubmed');
    if (pubmedProvider) {
      // For both direction with backward items present, only fetch forward citations
      const fallbackDirection = needsForwardFallback ? 'forward' : direction;
      const fallbackResult = await queryProvider(pubmedProvider, id, fallbackDirection, limit, articleYear);
      sourceResults.push(fallbackResult);
      allForward.push(...fallbackResult.forward_citations);
      allBackward.push(...fallbackResult.backward_references);
      if (fallbackResult.citation_count) allCounts.push(fallbackResult.citation_count);
      hasAnyItems = allForward.length > 0 || allBackward.length > 0;
    }
  }

  const result: FederatedCitationResult = {
    article_id: id,
    citation_counts: allCounts,
    forward_citations: deduplicateRecords(allForward),
    backward_references: deduplicateRecords(allBackward),
    source_results: sourceResults,
    items_available: hasAnyItems,
  };

  federatedCache.set(cacheKey, result);

  return result;
}

export function clearCitationCache(): void {
  federatedCache.shutdown();
}

export { buildCacheKey };

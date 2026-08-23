import type { ArticleSearchOptions, Article, ParsedDateRange } from '../types.js';
import { withTimeout } from '../../../connections/fetch-utils.js';
import { deduplicateAndRank } from './dedup.js';
import { searchPubMed } from './pubmed.js';
import { searchEuropePMC } from './europepmc.js';
import { searchSemanticScholar } from './semantic-scholar.js';
import { searchPubTator } from './pubtator.js';
import { searchLitSense } from './litsense.js';

const FEDERATED_SEARCH_TIMEOUT_MS = 20000;

export function parseDateRange(dateRange: string): ParsedDateRange {
  const [from, to] = dateRange.split('/');
  return {
    from: from || undefined,
    to: to || undefined,
  };
}

export async function articleSearch(
  query: string,
  options: ArticleSearchOptions = {}
): Promise<Article[]> {
  const { source, limit = 10, offset = 0 } = options;
  const dateRange = options.dateRange ? parseDateRange(options.dateRange) : undefined;

  if (source) {
    return searchSingleSource(query, source, limit, offset, options.cursorMark, dateRange);
  }

  return federatedSearch(query, limit, offset, dateRange);
}

async function federatedSearch(
  query: string,
  limit: number,
  offset: number,
  dateRange?: ParsedDateRange
): Promise<Article[]> {
  // Throw-on-timeout invariant: a hung backend must REJECT so Promise.allSettled
  // records it as an error result — a null would crash `allArticles.push(...null)`.
  const backends = dateRange
    ? [
        withTimeout(searchPubMed(query, limit, offset, dateRange), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'PubMed search' }),
        withTimeout(searchEuropePMC(query, limit, offset, undefined, dateRange), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'EuropePMC search' }),
        withTimeout(searchSemanticScholar(query, limit, offset, dateRange), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'SemanticScholar search' }),
      ]
    : [
        withTimeout(searchPubMed(query, limit, offset), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'PubMed search' }),
        withTimeout(searchEuropePMC(query, limit, offset), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'EuropePMC search' }),
        withTimeout(searchSemanticScholar(query, limit, offset), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'SemanticScholar search' }),
        withTimeout(searchPubTator(query, limit, offset), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'PubTator search' }),
        withTimeout(searchLitSense(query, limit, offset), FEDERATED_SEARCH_TIMEOUT_MS, { onTimeout: 'throw', label: 'LitSense search' }),
      ];

  const results = await Promise.allSettled(backends);
  const allArticles: Article[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allArticles.push(...result.value);
    }
  }

  return deduplicateAndRank(allArticles, limit);
}

async function searchSingleSource(
  query: string,
  source: string,
  limit: number,
  offset: number,
  cursorMark?: string,
  dateRange?: ParsedDateRange
): Promise<Article[]> {
  if (dateRange && (source === 'pubtator' || source === 'litsense')) {
    return [{ _error: `${source} does not support date filtering. Use pubmed, europepmc, or semantic_scholar.` } as any];
  }
  switch (source) {
    case 'pubmed': return searchPubMed(query, limit, offset, dateRange);
    case 'europepmc': return searchEuropePMC(query, limit, offset, cursorMark, dateRange);
    case 'semantic_scholar': return searchSemanticScholar(query, limit, offset, dateRange);
    case 'pubtator': return searchPubTator(query, limit, offset);
    case 'litsense': return searchLitSense(query, limit, offset);
    default: return [];
  }
}

import { connectionManager } from '../../../connections/manager.js';
import type { ArticleId, CitationRecord, CitationCount } from './types.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from './timeout.js';
import { withRetry } from '../../../connections/retry.js';

interface CrossrefWorkResponse {
  status?: string;
  message?: {
    'is-referenced-by-count'?: number;
    reference?: Array<{
      DOI?: string;
      author?: Array<{ family?: string; given?: string }>;
      year?: number;
      'article-title'?: string;
      'journal-title'?: string;
    }>;
  };
}

interface CrossrefForwardResponse {
  status?: string;
  message?: {
    items?: Array<{
      DOI?: string;
      title?: string[];
      author?: Array<{ family?: string; given?: string }>;
      'published-print'?: { 'date-parts'?: number[][] };
      'container-title'?: string[];
    }>;
    'total-results'?: number;
  };
}

const CROSSREF_RETRY_CONFIG = { maxRetries: 2, baseDelayMs: 100 };

interface CachedWork {
  references: CitationRecord[];
  count: CitationCount | null;
}

const workCache = new Map<string, { promise: Promise<CachedWork | null>; cleanup: ReturnType<typeof setTimeout> }>();

async function getCachedWorkData(id: ArticleId): Promise<CachedWork | null> {
  const key = id.doi || '';
  if (!key) return null;

  if (!workCache.has(key)) {
    const promise = (async () => {
      try {
        const conn = connectionManager.getConnection('crossref');
        const response = await withTimeout(
          conn.request(`/works/${encodeURIComponent(key)}`) as Promise<CrossrefWorkResponse>,
          DEFAULT_PROVIDER_TIMEOUT_MS
        );

        if (!response?.message) return null;

        function transformReference(ref: {
          DOI?: string;
          author?: Array<{ family?: string; given?: string }>;
          year?: number;
          'article-title'?: string;
          'journal-title'?: string;
        }): CitationRecord {
          return {
            doi: ref.DOI,
            title: ref['article-title'],
            authors: ref.author?.map((a: { family?: string; given?: string }) =>
              [a.given, a.family].filter(Boolean).join(' ')
            ),
            journal: ref['journal-title'],
            year: ref.year,
            source: 'crossref',
          };
        }

        const refs = (response.message.reference || []).slice(0, 50).map(transformReference);
        const count = response.message['is-referenced-by-count']
          ? { total: response.message['is-referenced-by-count'], source: 'crossref' }
          : null;

        return { references: refs, count };
      } catch {
        return null;
      }
    })();

    const cleanup = setTimeout(() => workCache.delete(key), 60000);
    if (cleanup.unref) cleanup.unref();
    workCache.set(key, { promise, cleanup });
  }

  return workCache.get(key)!.promise;
}

export function clearWorkCache(): void {
  for (const entry of workCache.values()) {
    clearTimeout(entry.cleanup);
  }
  workCache.clear();
}

export async function getForwardCitations(id: ArticleId, limit: number): Promise<CitationRecord[]> {
  const doi = id.doi;
  if (!doi) return [];

  try {
    const response = await withRetry(async () => {
      const conn = connectionManager.getConnection('crossref');
      return await withTimeout(
        conn.request(`/works?filter=references:${encodeURIComponent(doi)}&rows=${limit}`) as Promise<CrossrefForwardResponse>,
        DEFAULT_PROVIDER_TIMEOUT_MS
      );
    }, CROSSREF_RETRY_CONFIG);

    if (!response) return [];
    const items = response.message?.items || [];
    return items.map((item) => ({
      doi: item.DOI,
      title: item.title?.[0],
      authors: item.author?.map((a: { family?: string; given?: string }) =>
        [a.given, a.family].filter(Boolean).join(' ')
      ),
      journal: item['container-title']?.[0],
      year: item['published-print']?.['date-parts']?.[0]?.[0],
      source: 'crossref',
    }));
  } catch (error) {
    console.error('[crossref/getForwardCitations] Error:', error);
    return [];
  }
}

export async function getBackwardReferences(id: ArticleId, limit: number, articleYear?: number): Promise<CitationRecord[]> {
  if (!id.doi) return [];

  try {
    const cached = await getCachedWorkData(id);
    if (!cached) return [];

    const records = cached.references.slice(0, limit);

    // Filter backward references by publication year: only include items
    // published in the same year or earlier than the source article
    if (articleYear !== undefined) {
      return records.filter((record: CitationRecord) =>
        record.year === undefined || record.year <= articleYear
      );
    }
    return records;
  } catch (error) {
    console.error('[crossref/getBackwardReferences] Error:', error);
    return [];
  }
}

export async function getCitationCount(id: ArticleId): Promise<CitationCount | null> {
  if (!id.doi) return null;

  try {
    const cached = await getCachedWorkData(id);
    return cached?.count ?? null;
  } catch (error) {
    console.error('[crossref/getCitationCount] Error:', error);
    return null;
  }
}

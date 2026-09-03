import { connectionManager } from '../../../connections/manager.js';
import { HttpConnectionError } from '../../../connections/errors.js';
import type { ArticleId, CitationRecord, CitationCount } from './types.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from '../../../connections/fetch-utils.js';

interface CrossrefReference {
  DOI?: string;
  // Crossref delivers reference-list authors as a plain string
  // ("AD Lemly", "A One; B Two") — the structured {family, given} array
  // shape only applies to message.author (the work's own authors).
  author?: string | Array<{ family?: string; given?: string }>;
  year?: number;
  'article-title'?: string;
  'journal-title'?: string;
}

interface CrossrefWorkResponse {
  status?: string;
  message?: {
    'is-referenced-by-count'?: number;
    reference?: CrossrefReference[];
  };
}

interface CachedWork {
  references: CitationRecord[];
  count: CitationCount | null;
}

function normalizeCrossrefAuthors(author: CrossrefReference['author']): string[] | undefined {
  if (!author) return undefined;
  if (typeof author === 'string') {
    const parts = author.split(';').map(s => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(author)) {
    const mapped = author
      .map(a => [a.given, a.family].filter(Boolean).join(' '))
      .filter(Boolean);
    return mapped.length > 0 ? mapped : undefined;
  }
  return undefined;
}

function transformReference(ref: CrossrefReference): CitationRecord {
  return {
    doi: ref.DOI,
    title: ref['article-title'],
    authors: normalizeCrossrefAuthors(ref.author),
    journal: ref['journal-title'],
    year: ref.year,
    source: 'crossref',
  };
}

const workCache = new Map<string, { promise: Promise<CachedWork | null>; cleanup: ReturnType<typeof setTimeout> }>();

async function getCachedWorkData(id: ArticleId): Promise<CachedWork | null> {
  const key = id.doi || '';
  if (!key) return null;

  if (!workCache.has(key)) {
    // Stable failures (HTTP 404 = DOI unknown to Crossref) are memoized for
    // the TTL; transient ones (5xx, timeouts, network) are evicted on
    // resolution so the next caller retries.
    let stableNull = false;
    const promise = (async () => {
      try {
        const conn = connectionManager.getConnection('crossref');
        const response = await withTimeout(
          conn.request(`/works/${encodeURIComponent(key)}`) as Promise<CrossrefWorkResponse>,
          DEFAULT_PROVIDER_TIMEOUT_MS,
          { onTimeout: 'null' }
        );

        if (!response?.message) return null;

        // Count first and independently: a malformed reference entry must
        // never zero the citation count (the whole federation row shares
        // this single-flight result).
        const count = response.message['is-referenced-by-count']
          ? { total: response.message['is-referenced-by-count'], source: 'crossref' }
          : null;

        let references: CitationRecord[] = [];
        try {
          references = (response.message.reference || []).slice(0, 50).map(transformReference);
        } catch (error) {
          console.error('[crossref/transformReferences] Error:', error);
        }

        return { references, count };
      } catch (error) {
        if (error instanceof HttpConnectionError && error.status === 404) {
          stableNull = true;
        }
        console.error('[crossref/getCachedWorkData] Error:', error);
        return null;
      }
    })();

    const cleanup = setTimeout(() => workCache.delete(key), 60000);
    if (cleanup.unref) cleanup.unref();
    const entry = { promise, cleanup };
    workCache.set(key, entry);
    // Transient failures must not be memoized for the cache TTL — evict
    // immediately when the single-flight result is a transient null, while
    // keeping concurrent callers on the in-flight promise. The identity
    // check guards against a stale promise deleting a newer entry for the
    // same key after clearWorkCache().
    void promise.then((value) => {
      if (value === null && !stableNull && workCache.get(key) === entry) {
        clearTimeout(cleanup);
        workCache.delete(key);
      }
    }).catch(() => {
      if (workCache.get(key) === entry) {
        clearTimeout(cleanup);
        workCache.delete(key);
      }
    });
  }

  return workCache.get(key)!.promise;
}

export function clearWorkCache(): void {
  for (const entry of workCache.values()) {
    clearTimeout(entry.cleanup);
  }
  workCache.clear();
}

// Crossref removed the `references` filter from the REST API, so forward
// citation lists are served by Europe PMC / OpenCitations / Semantic Scholar.
// Crossref remains a count + backward-references provider via /works/{doi}.
export async function getForwardCitations(_id: ArticleId, _limit: number): Promise<CitationRecord[]> {
  return [];
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

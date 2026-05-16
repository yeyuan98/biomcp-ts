import { connectionManager } from '../../../connections/manager.js';
import type { ArticleId, CitationRecord, CitationCount } from './types.js';
import { withTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from './timeout.js';
import { withRetry } from '../../../connections/retry.js';

/**
 * Request queue for serializing Semantic Scholar API requests.
 * Prevents concurrent request conflicts that cause inconsistent data.
 */
class RequestQueue {
  private queue: Array<() => Promise<unknown>> = [];
  private active = false;
  private maxConcurrency = 1;

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.active || this.queue.length === 0) return;

    this.active = true;
    const fn = this.queue.shift();
    if (fn) {
      try {
        await fn();
      } finally {
        this.active = false;
        // Process next item in queue
        if (this.queue.length > 0) {
          this.process();
        }
      }
    }
  }
}

// Global request queue for Semantic Scholar to serialize all requests
const s2RequestQueue = new RequestQueue();

interface S2Paper {
  paperId?: string;
  title?: string;
  authors?: Array<{ name: string }>;
  year?: number;
  venue?: string;
  externalIds?: {
    PMID?: string;
    PMCID?: string;
    DOI?: string;
  };
}

interface S2CitationsResponse {
  data?: Array<{
    citationPaper?: S2Paper;
  }>;
}

interface S2ReferencesResponse {
  data?: Array<{
    citedPaper?: S2Paper;
  }>;
}

interface S2PaperResponse {
  citationCount?: number;
  referenceCount?: number;
}

// Retry configuration for Semantic Scholar
// Use shorter delays with API key, longer without
function getRetryConfig() {
  return {
    maxRetries: 3,
    baseDelayMs: process.env.S2_API_KEY ? 500 : 2000,
  };
}

function transformPaper(paper: S2Paper): CitationRecord {
  return {
    pmid: paper.externalIds?.PMID,
    pmcid: paper.externalIds?.PMCID,
    doi: paper.externalIds?.DOI,
    title: paper.title,
    authors: paper.authors?.map((a: { name: string }) => a.name),
    journal: paper.venue,
    year: paper.year,
    source: 'semantic_scholar',
  };
}

function resolveQueryId(id: ArticleId): string | null {
  if (id.pmid) return `PMID:${id.pmid}`;
  if (id.doi) return `DOI:${id.doi}`;
  if (id.pmcid) return `PMCID:${id.pmcid}`;
  return null;
}

export async function getForwardCitations(id: ArticleId, limit: number): Promise<CitationRecord[]> {
  const queryId = resolveQueryId(id);
  if (!queryId) return [];

  // Request buffer to account for items without IDs
  const requestLimit = Math.max(limit * 3, 10);

  try {
    return await s2RequestQueue.enqueue(async () => {
      return await withRetry(async () => {
        const conn = connectionManager.getConnection('semantic_scholar');

        const response = await withTimeout(
          conn.request(
            `/graph/v1/paper/${encodeURIComponent(queryId)}/citations?fields=title,authors,year,venue,externalIds&limit=${requestLimit}`
          ) as Promise<S2CitationsResponse>,
          DEFAULT_PROVIDER_TIMEOUT_MS
        );

        if (!response) return [];
        return (response.data || [])
          .filter((item: { citationPaper?: S2Paper }) => item.citationPaper?.paperId)
          .map((item: { citationPaper?: S2Paper }) => transformPaper(item.citationPaper!))
          .slice(0, limit);
      }, getRetryConfig());
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      console.warn(`[citation/semantic_scholar] Timeout fetching forward citations for ${queryId}`);
    } else if (msg.includes('429')) {
      console.warn(`[citation/semantic_scholar] Rate limited fetching forward citations for ${queryId}`);
    } else {
      console.error(`[citation/semantic_scholar] Error fetching forward citations for ${queryId}:`, error);
    }
    return [];
  }
}

export async function getBackwardReferences(id: ArticleId, limit: number, articleYear?: number): Promise<CitationRecord[]> {
  const queryId = resolveQueryId(id);
  if (!queryId) return [];

  // Request buffer to account for items without IDs and year filtering
  const requestLimit = Math.max(limit * 3, 10);

  try {
    return await s2RequestQueue.enqueue(async () => {
      return await withRetry(async () => {
        const conn = connectionManager.getConnection('semantic_scholar');

        const response = await withTimeout(
          conn.request(
            `/graph/v1/paper/${encodeURIComponent(queryId)}/references?fields=title,authors,year,venue,externalIds&limit=${requestLimit}`
          ) as Promise<S2ReferencesResponse>,
          DEFAULT_PROVIDER_TIMEOUT_MS
        );

        if (!response) return [];
        let records = (response.data || [])
          .filter((item: { citedPaper?: S2Paper }) => item.citedPaper?.paperId)
          .map((item: { citedPaper?: S2Paper }) => transformPaper(item.citedPaper!));

        // Filter backward references by publication year: only include items
        // published in the same year or earlier than the source article
        if (articleYear !== undefined) {
          records = records.filter((record: CitationRecord) =>
            record.year === undefined || record.year <= articleYear
          );
        }
        return records.slice(0, limit);
      }, getRetryConfig());
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      console.warn(`[citation/semantic_scholar] Timeout fetching backward references for ${queryId}`);
    } else if (msg.includes('429')) {
      console.warn(`[citation/semantic_scholar] Rate limited fetching backward references for ${queryId}`);
    } else {
      console.error(`[citation/semantic_scholar] Error fetching backward references for ${queryId}:`, error);
    }
    return [];
  }
}

export async function getCitationCount(id: ArticleId): Promise<CitationCount | null> {
  const queryId = resolveQueryId(id);
  if (!queryId) return null;

  try {
    return await s2RequestQueue.enqueue(async () => {
      return await withRetry(async () => {
        const conn = connectionManager.getConnection('semantic_scholar');

        return await withTimeout(
          conn.request(
            `/graph/v1/paper/${encodeURIComponent(queryId)}?fields=citationCount,referenceCount`
          ) as Promise<S2PaperResponse>,
          DEFAULT_PROVIDER_TIMEOUT_MS
        );
      }, getRetryConfig()).then((response) => {
        if (!response || response.citationCount === undefined) return null;
        return { total: response.citationCount, source: 'semantic_scholar' };
      });
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      console.warn(`[citation/semantic_scholar] Timeout fetching citation count for ${queryId}`);
    } else if (msg.includes('429')) {
      console.warn(`[citation/semantic_scholar] Rate limited fetching citation count for ${queryId}`);
    } else {
      console.error(`[citation/semantic_scholar] Error fetching citation count for ${queryId}:`, error);
    }
    return null;
  }
}

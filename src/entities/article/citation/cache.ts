import type { FederatedCitationResult } from './types.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class FederatedCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly defaultTtlMs: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(ttlMinutes: number = 10) {
    this.defaultTtlMs = ttlMinutes * 60 * 1000;
    // Cleanup every 2 minutes to prevent unbounded memory growth
    this.cleanupInterval = setInterval(() => this.cleanup(), 2 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set<T>(key: string, data: T, ttlMs?: number): void {
    const entry: CacheEntry<T> = {
      data,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    };
    this.cache.set(key, entry as CacheEntry<unknown>);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.cache.clear();
  }
}

function buildCacheKey(id: { pmid?: string; doi?: string; pmcid?: string }, options: { direction?: string; source?: string; full?: boolean; articleYear?: number }): string {
  // Canonical ID: PMID first, then DOI, then PMCID
  const canonicalId = id.pmid || id.doi || id.pmcid || '';
  const parts = [
    canonicalId,
    options.direction || 'both',
    options.source || (options.full ? 'full' : 'fast'),
    options.articleYear !== undefined ? `y${options.articleYear}` : undefined,
  ].filter(Boolean);
  return parts.join('|');
}

const federatedCache = new FederatedCache(10);

export { federatedCache, buildCacheKey };

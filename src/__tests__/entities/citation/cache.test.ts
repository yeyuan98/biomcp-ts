import { federatedCache, buildCacheKey } from '../../../entities/article/citation/cache.js';

describe('FederatedCache', () => {
  afterEach(() => {
    federatedCache.shutdown();
  });

  afterAll(() => {
    federatedCache.shutdown();
  });

  describe('get/set', () => {
    test('stores and retrieves values', () => {
      federatedCache.set('test-key', { data: 'test-value' });
      expect(federatedCache.get('test-key')).toEqual({ data: 'test-value' });
    });

    test('returns null for missing keys', () => {
      expect(federatedCache.get('nonexistent')).toBeNull();
    });

    test('returns null for expired entries', () => {
      federatedCache.set('expire-key', { data: 'test' }, 10); // 10ms TTL
      expect(federatedCache.get('expire-key')).toEqual({ data: 'test' });
      // Wait for expiration
      return new Promise(resolve => {
        setTimeout(() => {
          expect(federatedCache.get('expire-key')).toBeNull();
          resolve(undefined);
        }, 20);
      });
    });
  });

  describe('size', () => {
    test('reports cache size', () => {
      expect(federatedCache.size).toBe(0);
      federatedCache.set('key1', { data: 'value1' });
      expect(federatedCache.size).toBe(1);
      federatedCache.set('key2', { data: 'value2' });
      expect(federatedCache.size).toBe(2);
      federatedCache.set('key3', { data: 'value3' });
      expect(federatedCache.size).toBe(3);
    });

    test('size decreases when expired entries are cleaned', () => {
      federatedCache.set('temp-key', { data: 'test' }, 10);
      expect(federatedCache.size).toBe(1);
      return new Promise(resolve => {
        setTimeout(() => {
          federatedCache.cleanup();
          expect(federatedCache.size).toBe(0);
          resolve(undefined);
        }, 20);
      });
    });
  });

  describe('clear', () => {
    test('clears all entries', () => {
      federatedCache.set('key1', { data: 'value1' });
      federatedCache.set('key2', { data: 'value2' });
      expect(federatedCache.size).toBe(2);
      federatedCache.clear();
      expect(federatedCache.size).toBe(0);
      expect(federatedCache.get('key1')).toBeNull();
      expect(federatedCache.get('key2')).toBeNull();
    });
  });

  describe('cleanup', () => {
    test('removes expired entries but keeps valid ones', () => {
      federatedCache.set('short-key', { data: 'short' }, 10);
      federatedCache.set('long-key', { data: 'long' }, 10000);
      expect(federatedCache.size).toBe(2);
      return new Promise(resolve => {
        setTimeout(() => {
          federatedCache.cleanup();
          expect(federatedCache.size).toBe(1);
          expect(federatedCache.get('short-key')).toBeNull();
          expect(federatedCache.get('long-key')).toEqual({ data: 'long' });
          resolve(undefined);
        }, 20);
      });
    });

    test('cleanup is safe to call on empty cache', () => {
      expect(() => federatedCache.cleanup()).not.toThrow();
      expect(federatedCache.size).toBe(0);
    });
  });

  describe('shutdown', () => {
    test('clears interval and cache', () => {
      const cache1 = new (federatedCache.constructor as any)();
      cache1.set('key', { data: 'value' });
      expect(cache1.size).toBe(1);
      cache1.shutdown();
      expect(cache1.size).toBe(0);
    });
  });

  describe('buildCacheKey', () => {
    test('builds key with PMID', () => {
      const key = buildCacheKey({ pmid: '12345' }, { direction: 'forward', source: 'pubmed' });
      expect(key).toBe('12345|forward|pubmed');
    });

    test('builds key with DOI', () => {
      const key = buildCacheKey({ doi: '10.1234/test' }, { direction: 'both', source: 'crossref' });
      expect(key).toBe('10.1234/test|both|crossref');
    });

    test('builds key with PMCID', () => {
      const key = buildCacheKey({ pmcid: 'PMC1234567' }, { direction: 'backward', source: 'europepmc' });
      expect(key).toBe('PMC1234567|backward|europepmc');
    });

    test('builds key with multiple IDs uses PMID as canonical', () => {
      const key = buildCacheKey(
        { pmid: '12345', doi: '10.1234/test', pmcid: 'PMC1234567' },
        { direction: 'both', source: 'full' }
      );
      expect(key).toBe('12345|both|full');
    });

    test('builds key with DOI and PMCID uses DOI as canonical', () => {
      const key = buildCacheKey(
        { doi: '10.1234/test', pmcid: 'PMC1234567' },
        { direction: 'both', source: 'full' }
      );
      expect(key).toBe('10.1234/test|both|full');
    });

    test('defaults direction to both', () => {
      const key = buildCacheKey({ pmid: '12345' }, { source: 'pubmed' });
      expect(key).toBe('12345|both|pubmed');
    });

    test('defaults source to fast', () => {
      const key = buildCacheKey({ pmid: '12345' }, { direction: 'forward' });
      expect(key).toBe('12345|forward|fast');
    });

    test('uses full when full option is true', () => {
      const key = buildCacheKey({ pmid: '12345' }, { full: true });
      expect(key).toBe('12345|both|full');
    });
  });
});

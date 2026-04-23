import { SOURCE_REGISTRY, getSourceConfig, getSourcesByProtocol, getSourcesRequiringAuth, getSourcesWithOptionalAuth } from '../../connections/registry.js';

describe('SOURCE_REGISTRY', () => {
  it('has expected keys', () => {
    const expectedKeys = ['mygene', 'myvariant', 'mychem', 'pubmed', 'clinicaltrials', 'opentargets'];
    for (const key of expectedKeys) {
      expect(SOURCE_REGISTRY).toHaveProperty(key);
    }
  });
});

describe('getSourceConfig', () => {
  it('returns valid config for "mygene"', () => {
    const config = getSourceConfig('mygene');
    expect(config).toBeDefined();
    expect(config.baseUrl).toBe('https://mygene.info/v3');
    expect(config.protocol).toBe('rest');
    expect(config.rateLimit.intervalMs).toBe(100);
  });

  it('throws for unknown source', () => {
    expect(() => getSourceConfig('unknown')).toThrow('Unknown source: unknown');
  });
});

describe('getSourcesByProtocol', () => {
  it('returns REST sources', () => {
    const sources = getSourcesByProtocol('rest');
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(s => s.protocol === 'rest')).toBe(true);
  });

  it('returns GraphQL sources including opentargets', () => {
    const sources = getSourcesByProtocol('graphql');
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(s => s.protocol === 'graphql')).toBe(true);
    const ids = sources.map(s => s.sourceId);
    expect(ids).toContain('opentargets');
  });
});

describe('getSourcesRequiringAuth', () => {
  it('returns sources where auth.required === true', () => {
    const sources = getSourcesRequiringAuth();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(s => s.auth?.required === true)).toBe(true);
  });
});

describe('getSourcesWithOptionalAuth', () => {
  it('returns sources where auth exists but is not required', () => {
    const sources = getSourcesWithOptionalAuth();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(s => s.auth !== undefined && s.auth.required === false)).toBe(true);
  });
});

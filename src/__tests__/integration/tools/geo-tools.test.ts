import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

jest.setTimeout(60000);

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('geo tools (integration)', () => {
  it('geo_search finds GSE183947 by exact accession term', async () => {
    const results = await retryOnRateLimit(() =>
      harness.callTool('geo_search', { query: 'GSE183947', entry_type: 'gse', limit: 5 })
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    // Rank-independent: NCBI default sort is recency, so match by accession.
    const hit = results.find((r: any) => r.accession === 'GSE183947');
    expect(hit).toBeDefined();
    expect(hit.entry_type.toLowerCase()).toBe('gse');
    expect(hit.title).toBeTruthy();
    expect(hit.title.toLowerCase()).toContain('cytotoxicity');
    expect(hit.organism).toBe('Homo sapiens');
    expect(hit.pubmed_ids.map(String)).toContain('35046993');
  }, 60000);

  it('geo_get returns series details for GSE183947', async () => {
    // GEO SOFT (www.ncbi.nlm.nih.gov) drops datacenter connections for
    // extended windows once earlier suites have hammered NCBI — retry hard.
    const result = await retryOnRateLimit(
      () => harness.callTool('geo_get', { accession: 'GSE183947' }),
      7,
      5000,
    );
    expect(result.accession).toBe('GSE183947');
    expect(result.entry_type).toBe('series');
    expect(result.title).toBeTruthy();
    expect(result.n_samples).toBeGreaterThanOrEqual(50);
    expect(Array.isArray(result.samples)).toBe(true);
    expect(result.samples.length).toBeLessThanOrEqual(20);
    expect(result.samples[0].accession).toMatch(/^GSM\d+$/);
    // Cross-links for chaining: SRA project + BioProject + PubMed.
    expect(result.sra.map(String).join(' ')).toContain('SRP336638');
    expect(result.bioproject).toBe('PRJNA762469');
    expect(result.pubmed_ids.map(String)).toContain('35046993');
    expect(result.organisms).toContain('Homo sapiens');
    expect(result.platform_ids).toContain('GPL11154');
  }, 120000);

  it('geo_get returns sample details for GSM5574685', async () => {
    const result = await retryOnRateLimit(
      () => harness.callTool('geo_get', { accession: 'GSM5574685' }),
      7,
      5000,
    );
    expect(result.accession).toBe('GSM5574685');
    expect(result.entry_type).toBe('sample');
    expect(result.title).toBeTruthy();
    expect(result.organism).toBe('Homo sapiens');
    expect(result.platform_id).toBe('GPL11154');
    expect(result.series).toBe('GSE183947');
    expect(Array.isArray(result.characteristics)).toBe(true);
  }, 120000);

  it('geo_get returns curated-DataSet guidance for GDS accessions', async () => {
    // GDS passes schema validation; the entity guard fires before any fetch
    // and points users at the underlying GSE/GSM records.
    await expect(
      harness.callTool('geo_get', { accession: 'GDS1234' })
    ).rejects.toThrow(/curated GEO DataSet records.*series accession \(GSE\.\.\.\) or sample accession \(GSM\.\.\.\)/s);
  }, 30000);

  it('geo_get rejects malformed accessions', async () => {
    await expect(
      harness.callTool('geo_get', { accession: 'NOT-AN-ACCESSION' })
    ).rejects.toThrow();
  }, 30000);
});

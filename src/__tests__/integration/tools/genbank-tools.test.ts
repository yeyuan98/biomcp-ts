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

describe('genbank tools (integration)', () => {
  it('genbank_get returns TP53 RefSeqGene NG_017013.2 as fasta', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('genbank_get', { accession: 'NG_017013.2', format: 'fasta' })
    );
    expect(result.accession).toBe('NG_017013.2');
    expect(result.organism).toBe('Homo sapiens');
    expect(result.taxon_id).toBe(9606);
    expect(result.sourcedb.toLowerCase()).toContain('refseq');
    expect(result.format).toBe('fasta');
    // Fixed for a versioned RefSeq accession.
    expect(result.length_bp).toBe(32772);
    expect(result.sequence_text.startsWith('>')).toBe(true);
    expect(result.sequence_text).toContain('NG_017013.2');
  }, 60000);

  it('genbank_get errors on oversized whole-record fetch without a region', async () => {
    await expect(
      harness.callTool('genbank_get', { accession: 'NC_000001.11', format: 'genbank' })
    ).rejects.toThrow(/too large|seq_start|region/i);
  }, 60000);

  it('genbank_get returns a genbank-format region of NC_000001.11', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('genbank_get', {
        accession: 'NC_000001.11',
        format: 'genbank',
        seq_start: 1,
        seq_stop: 100,
      })
    );
    expect(result.accession).toBe('NC_000001.11');
    expect(result.format).toBe('genbank');
    expect(result.sequence_text).toContain('LOCUS');
    expect(result.region).toEqual({ start: 1, stop: 100, strand: 1 });
  }, 60000);

  it('genbank_search finds TP53 human records', async () => {
    const results = await retryOnRateLimit(() =>
      harness.callTool('genbank_search', {
        query: 'TP53[Gene Name] AND Homo sapiens[Organism]',
        limit: 3,
      })
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    const first = results[0];
    expect(first.accession).toMatch(/^[A-Z]/);
    expect(first.organism).toBe('Homo sapiens');
    expect(first.length_bp).toBeGreaterThan(0);
  }, 60000);

  it('genbank_genes maps NG_017013.2 to TP53 entrez gene 7157', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('genbank_genes', { accession: 'NG_017013.2' })
    );
    expect(Array.isArray(result.gene_ids)).toBe(true);
    expect(result.gene_ids.length).toBeGreaterThan(0);
    expect(result.gene_ids).toEqual(expect.arrayContaining([7157]));
  }, 60000);
});

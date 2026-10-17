import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
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
  it('genbank_get returns TP53 RefSeqGene NG_017013.2 as fasta (file mode, full data on disk)', async () => {
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
    // 32,772 bp of FASTA far exceeds the 1k-char inline ceiling: the reply
    // carries a file handle and NO inline sequence_text; the file holds the
    // complete record (never truncated).
    expect(result.mode).toBe('file');
    expect(result.truncated).toBe(false);
    expect(result.sequence_text).toBeUndefined();
    expect(result.char_count).toBe(result.total_char_count);
    expect(result.char_count).toBeGreaterThan(32_772);
    expect(result.file_path).toContain('NG_017013.2.fasta');
    const text = readFileSync(result.file_path, 'utf8');
    expect(text.startsWith('>')).toBe(true);
    expect(text).toContain('NG_017013.2');
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
        // Explicit inline opt-in: a GenBank flat file headers/features block
        // sits near the 1k-char auto-file ceiling, so pin the output mode
        // this assertion is about (the region echo + inline text).
        sequence_output: 'inline',
      })
    );
    expect(result.accession).toBe('NC_000001.11');
    expect(result.format).toBe('genbank');
    expect(result.sequence_text).toContain('LOCUS');
    expect(result.truncated).toBe(false);
    expect(result.region).toEqual({ start: 1, stop: 100, strand: 1 });
  }, 60000);

  it('accepts the docstring accession example KJ668569.1', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('genbank_get', { accession: 'KJ668569.1', format: 'fasta' })
    );
    expect(result.accession).toBe('KJ668569.1');
    expect(result.length_bp).toBe(600);
    expect(result.organism).toContain('Botryobasidium');
  }, 60000);

  it('genbank_get returns a 200 bp region slice of the NC_000908.2 genome', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('genbank_get', {
        accession: 'NC_000908.2',
        format: 'fasta',
        seq_start: 1,
        seq_stop: 200,
      })
    );
    expect(result.accession).toBe('NC_000908.2');
    expect(result.region).toEqual({ start: 1, stop: 200, strand: 1 });
    expect(result.sequence_text.startsWith('>')).toBe(true);
    // 200 bp of sequence plus the FASTA header and line wrapping.
    expect(result.sequence_text.length).toBeGreaterThanOrEqual(200);
    expect(result.sequence_text.length).toBeLessThanOrEqual(300);
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

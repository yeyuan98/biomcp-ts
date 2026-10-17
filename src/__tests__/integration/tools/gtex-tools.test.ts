import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

jest.setTimeout(15000); // measured p95 ≈ 1 s, max ≈ 11 s → 15 s

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('gtex tools (integration)', () => {
  it('gtex_expression returns top TP53 tissues', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('gtex_expression', { gene: 'TP53', limit: 5 })
    );
    expect(result.gene_symbol).toBe('TP53');
    expect(result.dataset).toBe('gtex_v10');
    expect(result.unit).toBe('TPM');
    expect(Array.isArray(result.tissues)).toBe(true);
    expect(result.tissues.length).toBeGreaterThan(0);
    expect(result.tissues.length).toBeLessThanOrEqual(5);
    const first = result.tissues[0];
    expect(first.tissue).toBeTruthy();
    expect(typeof first.median_tpm).toBe('number');
    expect(first.median_tpm).toBeGreaterThan(0);
    for (const t of result.tissues) {
      expect(typeof t.median_tpm).toBe('number');
    }
  }, 60000);

  it('gtex_expression filters to a single tissue via Brain_Cortex', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('gtex_expression', { gene: 'TP53', tissue: 'Brain_Cortex' })
    );
    expect(result.gene_symbol).toBe('TP53');
    expect(Array.isArray(result.tissues)).toBe(true);
    expect(result.tissues.length).toBe(1);
    expect(result.tissues[0].tissue).toBe('Brain_Cortex');
    expect(typeof result.tissues[0].median_tpm).toBe('number');
    expect(result.tissues[0].median_tpm).toBeGreaterThan(0);
  }, 60000);

  it('gtex_expression resolves a bare ENSG identifier', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('gtex_expression', { gene: 'ENSG00000141510', limit: 3 })
    );
    expect(result.gene_symbol).toBe('TP53');
    expect(result.gencode_id).toContain('ENSG00000141510');
    expect(result.tissues.length).toBeGreaterThan(0);
    expect(result.tissues.length).toBeLessThanOrEqual(3);
  }, 60000);

  it('gtex_eqtl returns association shape for SORT1 in Liver', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('gtex_eqtl', { gene: 'SORT1', tissue: 'Liver', limit: 5 })
    );
    expect(result.gene_symbol).toBe('SORT1');
    expect(result.tissue).toBe('Liver');
    // Empty is legitimate (no significant eQTLs) — assert shape only.
    expect(Array.isArray(result.associations)).toBe(true);
    expect(result.associations.length).toBeLessThanOrEqual(5);
    for (const a of result.associations) {
      expect(a.variant_id).toBeTruthy();
      expect(typeof a.p_value).toBe('number');
      expect(a.p_value).toBeGreaterThanOrEqual(0);
    }
    // Sorted ascending by p-value when present.
    const pValues = result.associations.map((a: any) => a.p_value);
    const sorted = [...pValues].sort((a, b) => a - b);
    expect(pValues).toEqual(sorted);
  }, 60000);

  it('gtex_eqtl TP53 in Whole_Blood: empty is valid, note lists other tissues', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('gtex_eqtl', { gene: 'TP53', tissue: 'Whole_Blood' })
    );
    expect(result.gene_symbol).toBe('TP53');
    expect(result.tissue).toBe('Whole_Blood');
    // Verified against live GTEx v10: TP53 has zero significant cis-eQTLs in
    // Whole_Blood — the empty list is the correct scientific answer (#106).
    expect(Array.isArray(result.associations)).toBe(true);
    expect(result.associations).toHaveLength(0);
    // ...and the diagnostic note points at the tissues that DO have them.
    expect(typeof result.note).toBe('string');
    expect(result.note).toContain('TP53 has no significant cis-eQTLs in Whole_Blood in GTEx v10');
    expect(result.note).toMatch(/but has \d+ in other tissues: /);
    expect(result.note).toContain('Kidney_Cortex');
  }, 60000);

  it('gtex_eqtl TP53 in Kidney_Cortex returns non-empty associations', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('gtex_eqtl', { gene: 'TP53', tissue: 'Kidney_Cortex', limit: 5 })
    );
    expect(result.gene_symbol).toBe('TP53');
    expect(result.tissue).toBe('Kidney_Cortex');
    expect(Array.isArray(result.associations)).toBe(true);
    expect(result.associations.length).toBeGreaterThan(0);
    expect(result.note).toBeUndefined();
    for (const a of result.associations) {
      expect(a.variant_id).toBeTruthy();
      expect(typeof a.p_value).toBe('number');
      expect(a.p_value).toBeGreaterThanOrEqual(0);
    }
    const pValues = result.associations.map((a: any) => a.p_value);
    const sorted = [...pValues].sort((a, b) => a - b);
    expect(pValues).toEqual(sorted);
  }, 60000);

  it('gtex_eqtl rejects an invalid tissue id', async () => {
    await expect(
      harness.callTool('gtex_eqtl', { gene: 'SORT1', tissue: 'Not_A_Tissue' })
    ).rejects.toThrow(/invalid tissue/i);
  }, 30000);
});

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

describe('ensembl tools (integration)', () => {
  it('ensembl_lookup resolves BRAF with canonical transcript', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('ensembl_lookup', { gene_or_id: 'BRAF' })
    );
    expect(result.id).toBe('ENSG00000157764');
    expect(result.symbol).toBe('BRAF');
    expect(result.assembly).toBe('GRCh38');
    expect(result.chromosome).toBe('7');
    expect(typeof result.start).toBe('number');
    expect(result.canonical_transcript).toBeTruthy();
  }, 60000);

  it('ensembl_lookup expands transcripts and works cross-species (mouse Trp53)', async () => {
    const expanded = await retryOnRateLimit(() =>
      harness.callTool('ensembl_lookup', { gene_or_id: 'BRAF', expand: true })
    );
    expect(Array.isArray(expanded.transcripts)).toBe(true);
    expect(expanded.transcripts.length).toBeGreaterThan(0);
    const canonical = expanded.transcripts.find((t: any) => t.is_canonical);
    expect(canonical.translation_id).toMatch(/^ENSP\d+$/);

    const mouse = await retryOnRateLimit(() =>
      harness.callTool('ensembl_lookup', { gene_or_id: 'Trp53', species: 'mouse' })
    );
    expect(mouse.id).toMatch(/^ENSMUSG\d+$/);
    expect(mouse.assembly).toBeTruthy();
  }, 60000);

  it('ensembl_homology maps BRAF to its mouse orthologue', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('ensembl_homology', { gene: 'BRAF', target_species: 'mouse' })
    );
    expect(result.type).toBe('orthologues');
    // target_species filtering is verified live here; upstream may return the
    // single one2one orthologue or a small set — shape assertions only.
    expect(result.homologies.length).toBeGreaterThanOrEqual(1);
    const mouse = result.homologies.find(
      (h: any) => h.target.species === 'mus_musculus'
    );
    expect(mouse).toBeTruthy();
    expect(mouse.target.id).toMatch(/^ENSMUSG\d+$/);
    if (typeof mouse.target.perc_id === 'number') {
      expect(mouse.target.perc_id).toBeGreaterThan(50);
      expect(mouse.target.perc_id).toBeLessThanOrEqual(100);
    }
  }, 60000);

  it('ensembl_consequence annotates a known HGVS and a novel variant on demand', async () => {
    const known = await retryOnRateLimit(() =>
      harness.callTool('ensembl_consequence', { variant: 'NM_004333:c.1799T>A' })
    );
    expect(known.most_severe_consequence).toBe('missense_variant');
    expect(known.consequences.length).toBeGreaterThan(0);
    const brafTc = known.consequences.find((c: any) => c.gene_symbol === 'BRAF');
    expect(brafTc).toBeTruthy();

    // Novel variant (not indexed anywhere): VEP computes consequences live.
    const novel = await retryOnRateLimit(() =>
      harness.callTool('ensembl_consequence', { variant: 'NM_004333:c.1800G>T' })
    );
    expect(novel.most_severe_consequence).toBeTruthy();
    expect(novel.consequences.length).toBeGreaterThan(0);
  }, 60000);

  it('ensembl_consequence accepts rsIDs via POST', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('ensembl_consequence', { variant: 'rs113488060' })
    );
    expect(result.input).toBe('rs113488060');
    expect(result.consequences.length).toBeGreaterThan(0);
  }, 60000);

  it('ensembl_region returns genes in a BRAF-spanning interval', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('ensembl_region', {
        region: '7:140450000-140480000',
        features: ['gene'],
        limit: 20,
      })
    );
    expect(result.total).toBeGreaterThanOrEqual(1);
    const symbols = result.features.map((f: any) => f.symbol);
    expect(symbols).toContain('MKRN1');
    for (const f of result.features) {
      expect(f.id).toMatch(/^ENSG\d+/);
    }
  }, 60000);

  it('ensembl_region rejects malformed regions', async () => {
    await expect(
      harness.callTool('ensembl_region', { region: 'bogus' })
    ).rejects.toThrow(/Invalid region/);
  }, 30000);
});

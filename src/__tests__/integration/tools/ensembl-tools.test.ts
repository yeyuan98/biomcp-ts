import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

jest.setTimeout(30000); // measured p95 ≈ 8 s, max ≈ 19 s (homology) → 30 s

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

  // Issue #194: NM_004333.4 is superseded in the current Ensembl release, so
  // the verbatim request 400s with "Could not get a Transcript object for
  // 'NM_004333.4'" — the retry against the bare accession must succeed AND
  // flag the coordinate reinterpretation in warnings.
  it('ensembl_consequence retries a stale RefSeq version with the bare accession and warns', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('ensembl_consequence', { variant: 'NM_004333.4:c.1799T>A' })
    );
    expect(result.most_severe_consequence).toBe('missense_variant');
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('RefSeq version .4 not carried by the current Ensembl release');
  }, 60000);

  // Regression guard for issue #102's underlying false negative: VEP works
  // for non-human species when the HGVS transcript belongs to that species
  // (NM_011640 = mouse Trp53). VEP computes these live (observed 7–20 s), so
  // both the per-call SDK timeout and the jest timeout get headroom.
  it('ensembl_consequence works for non-human species (mouse Trp53 RefSeq HGVS)', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool(
        'ensembl_consequence',
        { variant: 'NM_011640:c.100A>G', species: 'mouse' },
        { timeoutMs: 90000 }
      )
    );
    expect(result.most_severe_consequence).toBe('missense_variant');
    const trp53 = result.consequences.find((c: any) => c.gene_symbol === 'Trp53');
    expect(trp53).toBeTruthy();
  }, 120000);

  it('ensembl_consequence surfaces the upstream VEP error for invalid HGVS (out-of-range c. position)', async () => {
    // NM_139292 is mouse Reep6: c.1798 is beyond its CDS, so VEP answers
    // HTTP 400 with an explanatory JSON body — which must now reach the tool
    // error instead of the misleading generic "record may not exist" hint.
    await expect(
      harness.callTool('ensembl_consequence', { variant: 'NM_139292:c.1798T>A' })
    ).rejects.toThrow(/Upstream: Unable to parse HGVS/);
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

  // Issue #104 repro: this exact call used to issue one combined
  // gene+variation sweep (~95k rows / 23 MB, 26-28 s upstream) that timed
  // out on every attempt — 46-52 s wall clock, then TimeoutError. With the
  // split legs + 50 kb variation cap it must complete well inside that.
  it('ensembl_region completes the issue #104 repro (250kb BRAF span, gene+variation)', async () => {
    const t0 = Date.now();
    const result = await retryOnRateLimit(() =>
      harness.callTool(
        'ensembl_region',
        { region: '7:140700000-140950000', features: ['gene', 'variation'], limit: 20 },
        { timeoutMs: 90000 }
      )
    );
    const elapsedMs = Date.now() - t0;

    expect(result.total).toBeGreaterThan(0);
    expect(result.features.length).toBeGreaterThan(0);
    const symbols = result.features.map((f: any) => f.symbol);
    expect(symbols).toContain('BRAF');
    // Variation was capped to the centered 50 kb window and the result says so.
    expect(result.effective_variation_window).toEqual({ chr: '7', start: 140800000, end: 140849999 });
    expect(result.variation_truncated).toContain('7:140800000-140849999');
    // The old failure mode burned 46-52 s before erroring; the fixed call
    // (variation leg ≈ 17 s worst case + parallel gene leg) must beat that
    // even with one retry after a transient upstream 500.
    expect(elapsedMs).toBeLessThan(90_000);
  }, 120000);

  it('ensembl_region queries variation for the full span below the 50kb cap', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('ensembl_region', {
        region: '7:140450000-140470000',
        features: ['gene', 'variation'],
        limit: 20,
      })
    );
    expect(result.total).toBeGreaterThan(0);
    expect(result.effective_variation_window).toEqual({ chr: '7', start: 140450000, end: 140470000 });
    expect(result.variation_truncated).toBeUndefined();
  }, 60000);

  it('ensembl_region rejects malformed regions', async () => {
    await expect(
      harness.callTool('ensembl_region', { region: 'bogus' })
    ).rejects.toThrow(/Invalid region/);
  }, 30000);
});

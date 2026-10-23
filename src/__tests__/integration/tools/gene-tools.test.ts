import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectGeneSearchResult, expectGeneGetResult, expectCrossEntityDrugRows, expectCrossEntityTrialRows } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

jest.setTimeout(60000); // measured p95 ≈ 21 s (gene_enrich reactome legs); 60 s also matches the MCP client request cap

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

/** Run the callback with DISGENET_API_KEY unset (the keyless condition). */
async function withoutDisgenetKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.DISGENET_API_KEY;
  delete process.env.DISGENET_API_KEY;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.DISGENET_API_KEY = saved;
  }
}

describe('gene_search', () => {
  it('returns BRCA1 with stable identity', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'BRCA1' }));
    expectGeneSearchResult(results);
    const hit = results.find((r: any) => r.symbol === 'BRCA1');
    expect(hit).toBeDefined();
    expect(Number(hit!.entrez_id)).toBe(672);
  }, 60000);

  it('returns TP53 with stable identity', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'TP53' }));
    expectGeneSearchResult(results);
    const hit = results.find((r: any) => r.symbol === 'TP53');
    expect(hit).toBeDefined();
    expect(Number(hit!.entrez_id)).toBe(7157);
  }, 60000);

  it('returns results for EGFR', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'EGFR' }));
    expectGeneSearchResult(results);
    const hit = results.find((r: any) => r.symbol === 'EGFR');
    expect(hit).toBeDefined();
    expect(Number(hit!.entrez_id)).toBe(1956);
  }, 60000);

  it('returns empty for nonsense query', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'ZZZZZNOTAGENE99999' }));
    expectGeneSearchResult(results);
    expect(results.length).toBe(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'kinase', limit: 2 }));
    expectGeneSearchResult(results);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 60000);

  it('chromosome filter returns only Y-mapped genes', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'ribosomal protein', chromosome: 'Y', limit: 10 }));
    expectGeneSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    // The chromosome filter is client-side (an interval clause in q would
    // make mygene drop the text query, issue #98), so every returned row
    // must map to chromosome Y (multi-mapping PAR genes display the Y
    // coordinates).
    for (const r of results) {
      expect((r as Record<string, any>).genomic_coordinates?.chromosome).toBe('Y');
    }
  }, 60000);

  it('chromosome filter no longer drops the text query: BRAF on chr7 (issue #98)', async () => {
    // Regression: `q=BRAF AND chr7:1-999999999` made mygene discard the
    // BRAF clause entirely (0 results). With client-side filtering the top
    // relevance hit for BRAF survives the chr7 filter.
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'BRAF', chromosome: '7' }));
    expectGeneSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].symbol).toBe('BRAF');
    expect((results[0] as Record<string, any>).genomic_coordinates?.chromosome).toBe('7');
  }, 60000);

  it('chromosome filter excludes non-mapping genes: BRAF is not on chr17 (issue #98)', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'BRAF', chromosome: '17' }));
    expectGeneSearchResult(results);
    expect(results.length).toBe(0);
  }, 60000);

  it('single-token prefix fallback: BRCA returns BRCA1 and BRCA2 (issue #99)', async () => {
    // mygene's dismax is exact-token only: q=BRCA returns 0 hits upstream;
    // the symbol:BRCA* retry must surface the prefixed symbols.
    const results = await retryOnRateLimit(() => harness.callTool('gene_search', { query: 'BRCA' }));
    expectGeneSearchResult(results);
    const symbols = results.map((r: any) => r.symbol);
    expect(symbols).toContain('BRCA1');
    expect(symbols).toContain('BRCA2');
  }, 60000);
});

describe('gene_get', () => {
  it('returns BRCA1 core data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_get', { symbol: 'BRCA1' }));
    expectGeneGetResult(result);
    expect(result.symbol).toBe('BRCA1');
    expect(result.name).toBeTruthy();
  }, 60000);

  it('returns TP53 core data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_get', { symbol: 'TP53' }));
    expectGeneGetResult(result);
    expect(result.symbol).toBe('TP53');
  }, 60000);

  it('throws for invalid gene symbol', async () => {
    await expect(
      harness.callTool('gene_get', { symbol: 'INVALIDGENEXYZ999' })
    ).rejects.toThrow();
  }, 30000);
});

describe('gene_diseases', () => {
  it('returns diseases for BRCA1 via OpenTargets fallback', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_diseases', { symbol: 'BRCA1' }));
    expect(Array.isArray(result) || typeof result === 'object').toBe(true);
    if (Array.isArray(result)) {
      expect(result.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('keyless: returns OpenTargets-sourced diseases for TP53 (issue #84)', async () => {
    const result = await withoutDisgenetKey(() =>
      retryOnRateLimit(() => harness.callTool('gene_diseases', { symbol: 'TP53' }))
    );
    // DisGeNET has no key here, so every row must come from the OpenTargets
    // fallback and carry its source tag.
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const row of result) {
      expect(row.source).toBe('opentargets');
      expect(typeof row.name).toBe('string');
      expect(row.name.length).toBeGreaterThan(0);
    }
  }, 60000);
});

// The reverse direction of the same keyless fallback (issue #84): OT's
// associatedTargets serves disease→gene associations. Lives here (not in
// disease-tools) because it shares the gene_diseases fallback contract.
describe('disease_get gene_associations OpenTargets fallback (issue #84)', () => {
  it('keyless: MONDO:0005105 (melanoma) returns rows tagged opentargets', async () => {
    const result = await withoutDisgenetKey(() =>
      retryOnRateLimit(() => harness.callTool('disease_get', {
        disease_id: 'MONDO:0005105',
        sections: ['gene_associations'],
      }))
    );

    expect(result.sections).toBeDefined();
    const associations = result.sections.gene_associations;
    expect(Array.isArray(associations)).toBe(true);
    expect(associations.length).toBeGreaterThan(0);
    for (const row of associations) {
      expect(row._error).toBeUndefined();
      expect(row.source).toBe('opentargets');
      expect(typeof row.gene_symbol).toBe('string');
      expect(row.gene_symbol.length).toBeGreaterThan(0);
    }
    // Melanoma's top associated targets include BRAF (live OT ranking).
    expect(associations.some((r: any) => r.gene_symbol === 'BRAF')).toBe(true);
  }, 60000);
});

describe('gene_drugs', () => {
  it('returns drugs for EGFR with real OpenTargets rows', async () => {
    // gene_drugs replies are envelopes (issues #130/#179): { results,
    // warnings?, errors? } — failures ride in errors[], never as rows
    // inside results.
    const envelope = await retryOnRateLimit(() => harness.callTool('gene_drugs', { symbol: 'EGFR' }));
    expectCrossEntityDrugRows(envelope.results);
    // EGFR is a heavily drugged kinase target — real rows must exist.
    const realRows = envelope.results as Array<Record<string, any>>;
    expect(realRows.length).toBeGreaterThan(0);
    expect(realRows[0].source).toBe('opentargets');
  }, 60000);

  it('returns shape-valid (possibly empty) drugs for BRCA1', async () => {
    const envelope = await retryOnRateLimit(() => harness.callTool('gene_drugs', { symbol: 'BRCA1' }));
    expectCrossEntityDrugRows(envelope.results);
    // Zero rows is a valid live answer: BRCA1 is not a direct drug target in
    // OpenTargets (PARP inhibitors target PARP1/2, not BRCA1 itself).
  }, 60000);
});

describe('gene_trials', () => {
  it('returns trials for BRCA1', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('gene_trials', { symbol: 'BRCA1' }));
    expectCrossEntityTrialRows(result);
    const realRows = (result as Array<Record<string, any>>).filter((r) => !r._error);
    expect(realRows.length).toBeGreaterThan(0);
  }, 60000);
});

describe('gene_articles', () => {
  it('returns articles for BRCA1', async () => {
    // gene_articles replies are envelopes (issue #130): { results,
    // warnings?, errors? } — per-backend failures ride in errors, never as
    // rows inside results.
    const envelope = await retryOnRateLimit(() => harness.callTool('gene_articles', { symbol: 'BRCA1' }));
    expect(Array.isArray(envelope.results)).toBe(true);
    expect(envelope.results.length).toBeGreaterThan(0);
    const rows = envelope.results as Array<Record<string, any>>;
    // Federated ranking may lead with a non-PMID source (litsense, pubtator,
    // semantic_scholar, preprints), so row 1 is not required to carry a pmid.
    // The pmid contract applies where it is actually guaranteed: (a) at least
    // one row with a numeric pmid, (b) every pubmed/europepmc-sourced row,
    // and (c) titles are non-empty strings.
    expect(
      rows.some((r) => r.pmid !== undefined && /^\d+$/.test(String(r.pmid)))
    ).toBe(true);
    for (const row of rows) {
      if (row.source === 'pubmed' || row.source === 'europepmc') {
        expect(row.pmid).toBeDefined();
        expect(String(row.pmid)).toMatch(/^\d+$/);
      }
    }
    expect(typeof rows[0].title).toBe('string');
    expect(rows[0].title.length).toBeGreaterThan(0);
  }, 60000);
});

describe('gene_enrich', () => {
  // Issue #85's 10-gene cancer panel, submitted with duplicates and case
  // variants: 10 unique genes after dedup. genes_overlap is the count of
  // unique SUBMITTED genes Reactome matched per pathway (resolved with one
  // token follow-up request), so it is bounded by the unique input size.
  const CANCER_PANEL_10 = [
    'TP53', 'tp53', 'BRCA1', 'BRCA1 ', 'BRCA2', 'EGFR', 'KRAS',
    'PIK3CA', 'PTEN', 'APC', 'MYC', 'rb1',
  ];

  it('performs enrichment for a gene list and reports the contract honestly', async () => {
    // Upstream failures are explicit failures here (no soft-skip): the
    // harness rejects on isError with the surfaced upstream error.
    const result = await retryOnRateLimit(() =>
      harness.callTool('gene_enrich', { genes: CANCER_PANEL_10 })
    );

    expect(Array.isArray(result.pathways)).toBe(true);
    expect(result.pathways.length).toBeGreaterThan(0);
    for (const p of result.pathways) {
      expect(p.pathway_id).toMatch(/^R-HSA-\d+$/);
      expect(typeof p.name).toBe('string');
      expect(p.source).toBe('reactome');
      // Gene-level invariant (issue #85): genes_overlap counts unique
      // matched GENES — never Reactome's entity-level found, which exceeds
      // the gene count when one symbol projects onto several entities
      // (live 2026-10-16 probe: found=14 vs 7 genes in "Generic
      // Transcription Pathway") — so it must stay <= the 10 unique inputs.
      expect(p.genes_overlap).toBeLessThanOrEqual(10);
    }
    expect(typeof result.total_reported).toBe('number');
    expect(result.total_reported).toBeGreaterThanOrEqual(result.pathways.length);
    expect(typeof result.truncated).toBe('boolean');
    expect(result.truncated).toBe(result.total_reported > result.pathways.length);
  }, 90000);

  it('passes limit through: limit=5 returns at most 5 pathways with truncated flag', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('gene_enrich', { genes: CANCER_PANEL_10, limit: 5 })
    );

    expect(result.pathways.length).toBeLessThanOrEqual(5);
    expect(typeof result.total_reported).toBe('number');
    expect(typeof result.truncated).toBe('boolean');
    expect(result.truncated).toBe(result.total_reported > result.pathways.length);
  }, 90000);

  it('rejects input with fewer than 3 genes', async () => {
    await expect(
      harness.callTool('gene_enrich', { genes: ['BRCA1', 'TP53'] })
    ).rejects.toThrow(/at least 3 genes/);
  }, 30000);
});

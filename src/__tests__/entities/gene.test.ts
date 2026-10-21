import { jest } from '@jest/globals';
import { geneSearch, geneGet, transformMyGeneResponse } from '../../entities/gene.js';
import { connectionManager } from '../../connections/manager.js';
import { parseMockUrl } from '../helpers/mock-url.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';
import {
  brca1MinimalHit, brca1DnaRepairHit, brca1DnaRepairGeneHit, tp53TumorSuppressorHit,
} from '../fixtures/mygene.js';

describe('gene', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneSearch() calls connection with correct mygene search endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [brca1MinimalHit] }),
    }) as any;

    await geneSearch('brca1');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mygene.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('q=brca1');
  });

  test('geneSearch() returns transformed results', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{ symbol: 'BRCA1', name: 'BRCA1 DNA repair', entrezgene: 672 }],
      }),
    }) as any;

    const results = await geneSearch('brca1');

    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe('BRCA1');
    expect(results[0].name).toBe('BRCA1 DNA repair');
    expect(results[0].entrez_id).toBe(672);
  });

  test('geneGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{ symbol: 'BRCA1', name: 'BRCA1 DNA repair' }],
      }),
    }) as any;

    await geneGet('BRCA1');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mygene.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('symbol');
    expect(callUrl).toContain('BRCA1');
  });
});

// ============================================================
// geneSearch with options
// ============================================================
describe('geneSearch with options', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneSearch() sends the plain query and filters hits client-side on genomic_pos.chr', async () => {
    // Issue #98: mygene's q parser DISCARDS the text query whenever a
    // genomic-interval clause (chrN:start-end) rides along in q, so the
    // chromosome filter must never be sent upstream — hits are post-filtered
    // on genomic_pos.chr (object OR array shaped) instead.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          { symbol: 'BRAF', name: 'B-Raf proto-oncogene', entrezgene: 673, genomic_pos: { chr: '7', start: 140719327, end: 140924929 } },
          { symbol: 'TP53', name: 'Tumor protein p53', entrezgene: 7157, genomic_pos: { chr: '17', start: 7661779, end: 7687538 } },
          // Multi-mapping (PAR-style) array without a chr7 entry — dropped.
          { symbol: 'PARGENE', name: 'PAR gene', entrezgene: 1, genomic_pos: [{ chr: 'X', start: 1, end: 2 }, { chr: 'Y', start: 3, end: 4 }] },
          // Array-shaped genomic_pos including chr7 — kept, and the row
          // shows the chr7 coordinates (preferChromosome).
          { symbol: 'ARRAY7', name: 'Alt contig gene', entrezgene: 2, genomic_pos: [{ chr: '3', start: 5, end: 6 }, { chr: '7', start: 7, end: 8 }] },
          // No genomic_pos at all — dropped.
          { symbol: 'MIR123', name: 'microRNA 123', entrezgene: 100000 },
        ],
      }),
    }) as any;

    const results = await geneSearch('BRAF', { chromosome: '7' });

    // The plain text query rides alone in q (never an interval clause), and
    // the filtered scan pages upstream with size=100 from=0 — limit/offset
    // apply to the FILTERED list, not to the upstream request.
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    const url = new URL(callUrl);
    expect(url.searchParams.get('q')).toBe('BRAF');
    expect(url.searchParams.get('size')).toBe('100');
    expect(url.searchParams.get('from')).toBe('0');

    expect(results.map(r => r.symbol)).toEqual(['BRAF', 'ARRAY7']);
    expect(results[0].genomic_coordinates).toEqual({ chromosome: '7', start: 140719327, end: 140924929 });
    expect(results[1].genomic_coordinates).toEqual({ chromosome: '7', start: 7, end: 8 });
  });

  test('geneSearch() normalizes chromosome input (prefix, case, M→MT) for the client-side filter', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          { symbol: 'G17', name: 'Gene 17', entrezgene: 101, genomic_pos: { chr: '17', start: 1, end: 2 } },
          { symbol: 'G7', name: 'Gene 7', entrezgene: 102, genomic_pos: { chr: '7', start: 3, end: 4 } },
          { symbol: 'GX', name: 'Gene X', entrezgene: 103, genomic_pos: { chr: 'X', start: 5, end: 6 } },
          { symbol: 'GMT', name: 'Gene MT', entrezgene: 104, genomic_pos: { chr: 'MT', start: 7, end: 8 } },
        ],
      }),
    }) as any;

    const cases: Array<[string, string, string]> = [
      ['chr17', '17', 'G17'],
      ['CHR7', '7', 'G7'],
      ['x', 'X', 'GX'],
      ['M', 'MT', 'GMT'], // mygene keys mitochondrial as MT
      ['MT', 'MT', 'GMT'],
    ];
    for (const [input, expectedChr, expectedSymbol] of cases) {
      (global.fetch as any).mockClear();
      const results = await geneSearch('BRAF', { chromosome: input });
      // q stays the plain query — the normalized chromosome only feeds the
      // client-side filter value.
      const callUrl = (global.fetch as any).mock.calls[0][0] as string;
      expect(new URL(callUrl).searchParams.get('q')).toBe('BRAF');
      expect(results.map(r => r.symbol)).toEqual([expectedSymbol]);
      expect(results[0].genomic_coordinates?.chromosome).toBe(expectedChr);
    }
  });

  test('geneSearch() throws a validation error listing valid values for an invalid chromosome', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await expect(geneSearch('TP53', { chromosome: '23' })).rejects.toThrow(/Invalid chromosome '23'.*1-22/s);
    await expect(geneSearch('TP53', { chromosome: 'chrZ' })).rejects.toThrow(/Invalid chromosome 'chrZ'/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('geneSearch() uses custom limit and offset', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('EGFR', { limit: 5, offset: 10 });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=5');
    expect(callUrl).toContain('from=10');
  });

  test('geneSearch() uses default limit=10 and offset=0', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('BRCA1');

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('size=10');
    expect(callUrl).toContain('from=0');
  });

  test('geneSearch() does not include type/chr when options not provided', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    await geneSearch('BRCA1');

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).not.toContain('type=');
    expect(callUrl).not.toContain('chr=');
  });
});

// ============================================================
// geneSearch empty results
// ============================================================
describe('geneSearch empty results', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneSearch() returns empty array when API returns empty hits', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
    }) as any;

    const results = await geneSearch('NONEXISTENT_GENE_XYZ');
    expect(results).toEqual([]);
  });

  test('geneSearch() returns empty array when API returns no hits field', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }) as any;

    const results = await geneSearch('NONEXISTENT_GENE_XYZ');
    expect(results).toEqual([]);
  });
});

// ============================================================
// geneSearch with genomic_pos handling
// ============================================================
describe('geneSearch genomic_pos transformation', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneSearch() transforms genomic_pos into genomic_coordinates', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'BRCA1',
          name: 'BRCA1 DNA repair',
          entrezgene: 672,
          genomic_pos: [{ chr: '17', start: 43044295, end: 43125370 }],
        }],
      }),
    }) as any;

    const results = await geneSearch('BRCA1');

    expect(results).toHaveLength(1);
    expect(results[0].genomic_coordinates).toEqual({
      chromosome: '17',
      start: 43044295,
      end: 43125370,
    });
  });

  test('geneSearch() maps object-shaped genomic_pos (single mapping) to genomic_coordinates', async () => {
    // Live mygene /query returns a PLAIN OBJECT for single mappings
    // (TP53 → genomic_pos:{"chr":"17",...}); the array-only reader dropped it.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          entrezgene: 7157,
          genomic_pos: { chr: '17', start: 7661779, end: 7687538, strand: -1 },
        }],
      }),
    }) as any;

    const results = await geneSearch('TP53');

    expect(results).toHaveLength(1);
    expect(results[0].genomic_coordinates).toEqual({
      chromosome: '17',
      start: 7661779,
      end: 7687538,
    });
  });

  test('geneSearch() with chromosome filter keeps only matching rows from the plain-query response', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [
          { symbol: 'RPS4Y1', name: 'Ribosomal protein S4 Y-linked 1', entrezgene: 6192, genomic_pos: { chr: 'Y', start: 2714846, end: 2717537 } },
          { symbol: 'RPS4X', name: 'Ribosomal protein S4 X-linked', entrezgene: 6191, genomic_pos: { chr: 'X', start: 1, end: 2 } },
          // Multi-mapping hit: kept because one mapping is on Y, and the row
          // displays the Y coordinates.
          { symbol: 'PARGENE', name: 'PAR gene', entrezgene: 1, genomic_pos: [{ chr: 'X', start: 3, end: 4 }, { chr: 'Y', start: 111, end: 222 }] },
          { symbol: 'NOPOS', name: 'No mapping', entrezgene: 2 },
        ],
      }),
    }) as any;

    const results = await geneSearch('ribosomal protein', { chromosome: 'Y' });

    // The plain query rides alone in q (URL-decoded)…
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(new URL(callUrl).searchParams.get('q')).toBe('ribosomal protein');
    // …and only Y-mapped rows survive the client-side filter.
    expect(results.map(r => r.symbol)).toEqual(['RPS4Y1', 'PARGENE']);
    expect(results[0].genomic_coordinates).toEqual({
      chromosome: 'Y',
      start: 2714846,
      end: 2717537,
    });
    expect(results[1].genomic_coordinates).toEqual({ chromosome: 'Y', start: 111, end: 222 });
  });

  test('geneSearch() handles result without genomic_pos', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'MIR123',
          name: 'microRNA 123',
          entrezgene: 100000,
        }],
      }),
    }) as any;

    const results = await geneSearch('MIR123');

    expect(results).toHaveLength(1);
    expect(results[0].genomic_coordinates).toBeUndefined();
  });

  test('geneSearch() handles result with uniprot and omim fields', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          entrezgene: 7157,
          uniprot: ['P04637'],
          omim: [191170],
        }],
      }),
    }) as any;

    const results = await geneSearch('TP53');

    expect(results).toHaveLength(1);
    expect(results[0].uniprot_id).toBe('P04637');
    expect(results[0].omim_id).toBe('191170');
  });

  test('geneSearch() maps object-shaped uniprot ({SwissProt}) to uniprot_id', async () => {
    // Live mygene /query returns uniprot as {"SwissProt":"P04637"} (an
    // object, not a string array) — the array-only reader dropped it.
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          entrezgene: 7157,
          uniprot: { SwissProt: 'P04637' },
        }],
      }),
    }) as any;

    const results = await geneSearch('TP53');

    expect(results).toHaveLength(1);
    expect(results[0].uniprot_id).toBe('P04637');
  });
});

// ============================================================
// geneSearch chromosome-filter upstream paging (issue #98)
// ============================================================
describe('geneSearch chromosome-filter paging', () => {
  mockGlobalFetch();

  /** A page of filler hits all mapping to `chr` (no chr7 matches). */
  function fillerHits(count: number, chr: string): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_, i) => ({
      symbol: `FILLER${i}`,
      name: `Filler gene ${i}`,
      entrezgene: 900000 + i,
      genomic_pos: { chr, start: 1000 + i, end: 2000 + i },
    }));
  }

  function replyWith(pages: Record<string, Array<Record<string, unknown>>>) {
    return jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const from = parseMockUrl(input).searchParams.get('from') || '0';
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: pages[from] || [] }),
      });
    }) as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('pages upstream (size=100) until enough filtered rows are collected', async () => {
    // Page 1 is a FULL page (100 hits) with one chr7 match — not enough for
    // limit=3, so the scan must fetch page 2 (from=100) and merge.
    const pages: Record<string, Array<Record<string, unknown>>> = {
      '0': [
        { symbol: 'MATCH1', name: 'Match 1', entrezgene: 1, genomic_pos: { chr: '7', start: 11, end: 12 } },
        ...fillerHits(99, '1'),
      ],
      '100': [
        { symbol: 'MATCH2', name: 'Match 2', entrezgene: 2, genomic_pos: { chr: '7', start: 21, end: 22 } },
        { symbol: 'MATCH3', name: 'Match 3', entrezgene: 3, genomic_pos: { chr: '7', start: 31, end: 32 } },
        ...fillerHits(98, '1'),
      ],
    };
    global.fetch = replyWith(pages);

    const results = await geneSearch('kinase', { chromosome: '7', limit: 3 });

    expect((global.fetch as any).mock.calls).toHaveLength(2);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => new URL(c[0] as string));
    expect(urls[0].searchParams.get('from')).toBe('0');
    expect(urls[1].searchParams.get('from')).toBe('100');
    expect(urls[0].searchParams.get('size')).toBe('100');
    // Relevance order is preserved across the merged pages.
    expect(results.map(r => r.symbol)).toEqual(['MATCH1', 'MATCH2', 'MATCH3']);
    expect(results.map(r => r.genomic_coordinates?.chromosome)).toEqual(['7', '7', '7']);
  });

  test('stops paging on a short upstream page without a truncation warning', async () => {
    // Page 2 is short (50 hits): upstream ran out of hits, so the scan is
    // complete even though fewer than `limit` rows were gathered — no fetch
    // beyond page 2, no _warning.
    const pages: Record<string, Array<Record<string, unknown>>> = {
      '0': fillerHits(100, '1'),
      '100': [
        { symbol: 'MATCH1', name: 'Match 1', entrezgene: 1, genomic_pos: { chr: '7', start: 11, end: 12 } },
        ...fillerHits(49, '1'),
      ],
    };
    global.fetch = replyWith(pages);

    const results = await geneSearch('kinase', { chromosome: '7' });

    expect((global.fetch as any).mock.calls).toHaveLength(2);
    expect(results.map(r => r.symbol)).toEqual(['MATCH1']);
    expect(results[0]._warning).toBeUndefined();
  });

  test('warns when the 3-page scan cap exhausts before enough filtered rows', async () => {
    // Three FULL pages with only two chr7 matches in total: the bounded scan
    // window (top ~300 relevance hits) is exhausted → every returned row
    // carries a _warning disclosing possibly-incomplete results.
    const pages: Record<string, Array<Record<string, unknown>>> = {
      '0': [
        { symbol: 'MATCH1', name: 'Match 1', entrezgene: 1, genomic_pos: { chr: '7', start: 11, end: 12 } },
        ...fillerHits(99, '1'),
      ],
      '100': fillerHits(100, '1'),
      '200': [
        { symbol: 'MATCH2', name: 'Match 2', entrezgene: 2, genomic_pos: { chr: '7', start: 21, end: 22 } },
        ...fillerHits(99, '1'),
      ],
    };
    global.fetch = replyWith(pages);

    const results = await geneSearch('kinase', { chromosome: '7' });

    expect((global.fetch as any).mock.calls).toHaveLength(3);
    expect(results.map(r => r.symbol)).toEqual(['MATCH1', 'MATCH2']);
    for (const row of results) {
      expect(row._warning).toMatch(/may be incomplete[\s\S]*scan window[\s\S]*exhausted/);
    }
    // Every upstream fetch carried the plain query — no interval clause and
    // no symbol fallback (the initial search was non-empty).
    for (const c of (global.fetch as any).mock.calls) {
      expect(new URL(c[0] as string).searchParams.get('q')).toBe('kinase');
    }
  });
});

// ============================================================
// geneSearch 0-hit single-token prefix fallback (issue #99)
// ============================================================
describe('geneSearch prefix fallback (issue #99)', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('retries once with symbol:<token>* when a single-token query returns 0 hits', async () => {
    // mygene's dismax is exact-token only: q=BRCA → total 0 / 0 hits, while
    // symbol:BRCA* prefix-matches BRCA1/BRCA2/... case-insensitively. The
    // genuinely-empty signal is total === 0 (mygene always reports total).
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(callIndex === 1
          ? { total: 0, hits: [] }
          : {
            total: 2,
            hits: [
              { symbol: 'BRCA1', name: 'BRCA1 DNA repair', entrezgene: 672, genomic_pos: { chr: '17', start: 43044295, end: 43125370 } },
              { symbol: 'BRCA2', name: 'BRCA2 DNA repair', entrezgene: 675, genomic_pos: { chr: '13', start: 32315086, end: 32400266 } },
            ],
          }),
      });
    }) as any;

    const results = await geneSearch('BRCA');

    expect((global.fetch as any).mock.calls).toHaveLength(2);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => new URL(c[0] as string));
    expect(urls[0].searchParams.get('q')).toBe('BRCA');
    expect(urls[1].searchParams.get('q')).toBe('symbol:BRCA*');
    expect(results.map(r => r.symbol)).toEqual(['BRCA1', 'BRCA2']);
  });

  test('does not retry for multi-word queries (exactly one fetch)', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ total: 0, hits: [] }),
    }) as any;

    const results = await geneSearch('dna repair gene');

    expect((global.fetch as any).mock.calls).toHaveLength(1);
    expect(results).toEqual([]);
  });

  test('escapes Lucene specials in the fallback token', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(callIndex === 1
          ? { total: 0, hits: [] }
          : { total: 1, hits: [{ symbol: 'BRCA1', name: 'BRCA1 DNA repair' }] }),
      });
    }) as any;

    await geneSearch('BRCA1/2');

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => new URL(c[0] as string));
    expect(urls[1].searchParams.get('q')).toBe('symbol:BRCA1\\/2*');
  });

  test('applies the chromosome post-filter to fallback results too', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(callIndex === 1
          ? { total: 0, hits: [] } // plain q=KRAS: 0 upstream hits
          : {
            total: 3,
            hits: [
              { symbol: 'KRAS', name: 'KRAS proto-oncogene', entrezgene: 3845, genomic_pos: { chr: '7', start: 140719327, end: 140924929 } },
              { symbol: 'KRASP8', name: 'KRAS pseudogene 8', entrezgene: 1, genomic_pos: { chr: '8', start: 1, end: 2 } },
              { symbol: 'NOMATCH', name: 'No mapping', entrezgene: 2 },
            ],
          }),
      });
    }) as any;

    const results = await geneSearch('KRAS', { chromosome: '7' });

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => new URL(c[0] as string));
    expect((global.fetch as any).mock.calls).toHaveLength(2);
    expect(urls[0].searchParams.get('q')).toBe('KRAS');
    expect(urls[1].searchParams.get('q')).toBe('symbol:KRAS*');
    expect(results.map(r => r.symbol)).toEqual(['KRAS']);
    expect(results[0].genomic_coordinates?.chromosome).toBe('7');
  });

  test('offset past the end returns an empty page — no fallback re-query (exactly one fetch)', async () => {
    // Live-verified mygene contract (issue #122): q=BRAF&from=20 with
    // total=16 returns hits: [] with total intact. A zero-hit page at a
    // deep offset is graceful end-of-pagination, NOT an unmatched token —
    // the #99 prefix fallback must not fire (it would re-query from=0 and
    // wrap pagination back to the first page).
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ total: 16, hits: [] }),
    }) as any;

    const results = await geneSearch('BRAF', { limit: 5, offset: 20 });

    expect((global.fetch as any).mock.calls).toHaveLength(1);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => new URL(c[0] as string));
    expect(urls[0].searchParams.get('q')).toBe('BRAF');
    expect(urls[0].searchParams.get('from')).toBe('20');
    expect(results).toEqual([]);
  });

  test('offset pagination is monotonic: offsets past the end stay empty (no wrap to page 0)', async () => {
    // Issue #122 sweep on a 2-hit result set: offsets 0 / 2 (= total) /
    // 7 (= total+5) / 1000 must yield [full page, [], [], []] — never the
    // first page again.
    const allHits = [
      { symbol: 'BRAF', name: 'B-Raf proto-oncogene', entrezgene: 673, genomic_pos: { chr: '7', start: 140719327, end: 140924929 } },
      { symbol: 'BRAFP1', name: 'BRAF pseudogene 1', entrezgene: 228211, genomic_pos: { chr: 'X', start: 36633374, end: 36664497 } },
    ];
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const from = parseInt(new URL(input as string).searchParams.get('from') || '0', 10);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ total: allHits.length, hits: allHits.slice(from) }),
      });
    }) as any;

    const pages = [];
    for (const offset of [0, 2, 7, 1000]) {
      pages.push(await geneSearch('BRAF', { limit: 5, offset }));
    }

    expect(pages.map(p => p.map(r => r.symbol))).toEqual([
      ['BRAF', 'BRAFP1'],
      [],
      [],
      [],
    ]);
    // Exactly one upstream fetch per page — no prefix fallback, no wrap.
    expect((global.fetch as any).mock.calls).toHaveLength(4);
    const froms = (global.fetch as any).mock.calls.map(
      (c: any[]) => new URL(c[0] as string).searchParams.get('from')
    );
    expect(froms).toEqual(['0', '2', '7', '1000']);
  });

  test('fallback still fires when total === 0, re-requesting at the caller offset', async () => {
    // #99 regression guard: total === 0 is the genuinely-empty signal the
    // prefix fallback keys on. The re-request must carry the caller's
    // offset (never a hardcoded from=0), so a fallback that fires on a
    // deep page still respects pagination.
    for (const offset of [0, 5]) {
      jest.clearAllMocks();
      let callIndex = 0;
      global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
        callIndex++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(callIndex === 1
            ? { total: 0, hits: [] }
            : { total: 1, hits: [{ symbol: 'BRCA1', name: 'BRCA1 DNA repair' }] }),
        });
      }) as any;

      await geneSearch('BRCA', { limit: 5, offset });

      expect((global.fetch as any).mock.calls).toHaveLength(2);
      const urls = (global.fetch as any).mock.calls.map((c: any[]) => new URL(c[0] as string));
      expect(urls[0].searchParams.get('from')).toBe(String(offset));
      expect(urls[1].searchParams.get('q')).toBe('symbol:BRCA*');
      expect(urls[1].searchParams.get('from')).toBe(String(offset));
    }
  });
});

// ============================================================
// geneGet with sections
// ============================================================
describe('geneGet with sections', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() with pathways section triggers section fetch', async () => {
    // First call: gene lookup via mygene
    // Second call: reactome pathway fetch
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // mygene lookup
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1 DNA repair',
              summary: 'A DNA repair gene.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Reactome pathway lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            entries: [{
              type: 'Pathway',
              stId: 'R-HSA-5693568',
              name: 'HDR through Homologous Recombination',
            }],
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['pathways']);

    expect(result.symbol).toBe('BRCA1');
    expect(Object.keys(result.sections!)).toEqual(['pathways']);
    expect(result.sections!.pathways).toHaveLength(1);
    expect((result.sections!.pathways as any[])[0].name).toBe('HDR through Homologous Recombination');
    expect((result.sections!.pathways as any[])[0].source).toBe('reactome');
  });

  test('geneGet() with protein section triggers uniprot fetch', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // UniProt fetch
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: [{
            primaryAccession: 'P04637',
            proteinDescription: {
              recommendedName: { fullName: { value: 'Cellular tumor antigen p53' } },
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['protein']);

    expect(Object.keys(result.sections!)).toEqual(['protein']);
    expect((result.sections!.protein as any).accession).toBe('P04637');
    expect((result.sections!.protein as any).name).toBe('Cellular tumor antigen p53');
  });

  test('geneGet() fetches multiple sections in parallel', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [brca1DnaRepairHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // For any subsequent call, return a generic response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [], hits: [{ go: {} }] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['pathways', 'protein']);

    // Both sections should be present (even if empty data from generic mock);
    // parallel fetch completion order is nondeterministic, so compare sorted.
    expect(Object.keys(result.sections!).sort()).toEqual(['pathways', 'protein']);
    // Should have made more than one fetch call
    expect(global.fetch).toHaveBeenCalledTimes(3); // 1 gene lookup + 2 section fetches
  });
});

// ============================================================
// geneGet with smart=true and alias resolution
// ============================================================
describe('geneGet with smart alias resolution', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() smart=true resolves alias when exact match fails', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // First lookup: no exact match
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias lookup: finds matching alias
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              _id: '672',
              symbol: 'BRCA1',
              alias: ['RNF53', 'FANCS'],
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Third call: lookup by resolved symbol
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [brca1DnaRepairGeneHit],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('RNF53', undefined, true);

    expect(result.symbol).toBe('BRCA1');
    expect(result.name).toBe('BRCA1 DNA repair');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('geneGet() smart=true, alias not found throws smart-specific error', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // First lookup: no exact match
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Alias lookup: no alias found
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: [] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    await expect(geneGet('COMPLETELY_UNKNOWN_GENE_XYZ', undefined, true))
      .rejects.toThrow('No matching gene found for this name or alias');
  });
});

// ============================================================
// geneGet with smart=false, no hits
// ============================================================
describe('geneGet without smart mode', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() smart=false, no hits throws error suggesting smart=true', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    await expect(geneGet('UNKNOWN_GENE_XYZ'))
      .rejects.toThrow('Use gene_search to find the official symbol, or enable smart=true for automatic alias resolution');
  });

  test('geneGet() with no smart param defaults to non-smart behavior', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [] }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    await expect(geneGet('UNKNOWN_GENE'))
      .rejects.toThrow('Use gene_search to find the official symbol');
  });
});

// ============================================================
// geneGet error in section fetch
// ============================================================
describe('geneGet section fetch error handling', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() returns partial results when a section fetch fails', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // Gene lookup succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [brca1DnaRepairGeneHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Section fetch fails
        return Promise.reject(new Error('Network timeout'));
      }
      // Fallback
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [], hits: [] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['pathways']);

    expect(result.symbol).toBe('BRCA1');
    expect(Object.keys(result.sections!)).toEqual(['pathways']);
    // Failed section should have an error entry (fetchPathways catches internally)
    // fetchPathways catches errors and returns an array with _error
    const pathwaysData = result.sections!.pathways as Array<{ _error: string }>;
    expect(pathwaysData).toHaveLength(1);
    expect(pathwaysData[0]._error).toContain('Pathway lookup failed');
  });
});

// ============================================================
// geneGet with 'all' sections
// ============================================================
describe('geneGet with all sections', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() with sections=["all"] fetches all known sections', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // All section fetches return minimal data
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [], hits: [], data: {} }),
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('[]'),
        arrayBuffer: () => Promise.resolve(Buffer.from('[]')),
      });
    }) as any;

    const result = await geneGet('TP53', ['all']);

    expect(result.symbol).toBe('TP53');
    expect(result.sections).toBeDefined();
    // Should have many sections - the code fetches 14 sections for 'all'
    const sectionKeys = Object.keys(result.sections!);
    expect(sectionKeys.length).toBeGreaterThanOrEqual(14);
    // Verify some expected section keys
    expect(sectionKeys).toContain('pathways');
    expect(sectionKeys).toContain('protein');
    expect(sectionKeys).toContain('ontology');
    expect(sectionKeys).toContain('interactions');
    expect(sectionKeys).toContain('civic');
    expect(sectionKeys).toContain('expression');
  });
});

// ============================================================
// geneGet abort/timeout handling
// ============================================================
describe('geneGet abort/timeout handling', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() handles AbortError from fetch', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    global.fetch = jest.fn<(...args: any[]) => any>().mockRejectedValue(abortError) as any;

    // The abort must propagate as the original DOMException (name + message),
    // not a generic opaque failure.
    await expect(geneGet('BRCA1')).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The operation was aborted',
    });
  });
});

// ============================================================
// geneGet section timeout budget (issue #195)
// ============================================================
describe('geneGet section timeout budget (issue #195)', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const mygeneLookup = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve({ hits: [tp53TumorSuppressorHit] }),
  };

  // NIH Reporter routinely answers in 5-10 s — inside the registry's raised
  // 20 s handling.timeoutMs, past the old flat 8 s section cap.
  test('funding section succeeds past 8 s by honoring the nih_reporter registry budget', async () => {
    jest.useFakeTimers();
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) return Promise.resolve(mygeneLookup);
      return new Promise(resolve => setTimeout(() => resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({
          results: [{
            project_num: 'R01CA999999',
            project_title: 'TP53 dynamics',
            agency_code: 'NCI',
            award_amount: 123456,
          }],
        }),
      }), 9500));
    }) as any;

    const pending = geneGet('TP53', ['funding']);
    // Fire the 9.5 s NIH response — before the 20 s section budget.
    await jest.advanceTimersByTimeAsync(9500);
    const result = await pending;

    const funding = result.sections!.funding as { grants?: Array<{ nih_id: string }>; _error?: string };
    expect(funding._error).toBeUndefined();
    expect(funding.grants?.[0]?.nih_id).toBe('R01CA999999');
  });

  // hpa is a raw proteinatlas.org fetch with no registry source — it must
  // stay bounded by the 8 s SECTION_TIMEOUT_MS fallback.
  test('a section without a registry source stays bounded at the 8 s fallback', async () => {
    jest.useFakeTimers();
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) return Promise.resolve(mygeneLookup);
      return new Promise(resolve => setTimeout(() => resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve([]),
      }), 9000));
    }) as any;

    const pending = geneGet('TP53', ['hpa']);
    // Advance past the 8 s fallback deadline (response still pending).
    await jest.advanceTimersByTimeAsync(8100);
    const result = await pending;

    const hpa = result.sections!.hpa as { _error?: string };
    expect(hpa._error).toContain('timed out after 8000ms');
    // Settle the dangling 9 s mock response so no timer leaks the test.
    await jest.advanceTimersByTimeAsync(1000);
  });
});

// ============================================================
// geneGet with genomic_pos transformation
// ============================================================
describe('geneGet genomic_pos handling', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() sets chromosome and position from genomic_pos', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'BRCA1',
          name: 'BRCA1 DNA repair',
          summary: 'DNA repair.',
          genomic_pos: [{ chr: '17', start: 43044295, end: 43125370 }],
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('BRCA1');

    expect(result.chromosome).toBe('17');
    expect(result.position).toBe('43044295-43125370');
  });

  test('geneGet() handles non-array genomic_pos', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          genomic_pos: { chr: '17', start: 7661779, end: 7687538 },
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('TP53');

    expect(result.chromosome).toBe('17');
    expect(result.position).toBe('7661779-7687538');
  });

  test('geneGet() handles missing genomic_pos', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'MIRLET7A1',
          name: 'microRNA let-7a-1',
          summary: 'A microRNA.',
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('MIRLET7A1');

    expect(result.chromosome).toBeUndefined();
    expect(result.position).toBeUndefined();
  });
});

// ============================================================
// geneGet section aliases
// ============================================================
describe('geneGet section aliases', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() maps dosage_sensitivity alias to clingen', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [brca1DnaRepairHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // clingen always returns error stub
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['dosage_sensitivity']);

    expect(Object.keys(result.sections!)).toEqual(['clingen']);
    // clingen returns an error object about no public API
    expect(result.sections!.clingen).toMatchObject({ _error: expect.stringContaining('ClinGen') });
  });

  test('geneGet() maps protein_atlas alias to hpa', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((url: string) => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRCA1',
              name: 'BRCA1',
              summary: 'DNA repair.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // HPA fetch — proteinatlas.org
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { Gene: 'BRCA1', 'Subcellular location': ['Nucleus', 'Cytoplasm'] },
        ]),
        headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify([
          { Gene: 'BRCA1', 'Subcellular location': ['Nucleus', 'Cytoplasm'] },
        ]))),
        text: () => Promise.resolve(JSON.stringify([
          { Gene: 'BRCA1', 'Subcellular location': ['Nucleus', 'Cytoplasm'] },
        ])),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['protein_atlas']);

    expect(Object.keys(result.sections!)).toEqual(['hpa']);
    // The mocked HPA row maps to approved subcellular locations verbatim.
    expect(result.sections!.hpa).toEqual({
      subcellular: [
        { location: 'Nucleus', confidence: 'approved' },
        { location: 'Cytoplasm', confidence: 'approved' },
      ],
    });
  });
});

// ============================================================
// resolveGeneAlias - case-exact match priority
// ============================================================
describe('resolveGeneAlias via geneGet smart', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() smart mode prefers case-exact alias match', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // First lookup: no exact match
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias lookup: two hits with different case aliases
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [
              {
                _id: '100',
                symbol: 'GENEA',
                alias: ['aliasA', 'CASEMATCH'],  // case-exact match for 'CASEMATCH'
              },
              {
                _id: '200',
                symbol: 'GENEB',
                alias: ['casematch'],  // case-insensitive only
              },
            ],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Third call: resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            symbol: 'GENEA',
            name: 'Gene A',
            summary: 'Gene A description.',
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('CASEMATCH', undefined, true);

    // Should resolve to GENEA because it has the case-exact alias 'CASEMATCH'
    expect(result.symbol).toBe('GENEA');
  });

  test('geneGet() smart mode falls back to case-insensitive alias match', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias lookup: only case-insensitive match available
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              _id: '672',
              symbol: 'BRCA1',
              alias: ['rnf53', 'fancs'],  // lowercase alias for RNF53
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [brca1DnaRepairHit],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('RNF53', undefined, true);

    // Should resolve to BRCA1 via case-insensitive match
    expect(result.symbol).toBe('BRCA1');
  });

  test('geneGet() smart mode handles string alias (not array)', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Alias returned as a single string (not array)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              _id: '672',
              symbol: 'BRCA1',
              alias: 'FANCS',  // string, not array
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [brca1DnaRepairHit],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('FANCS', undefined, true);

    expect(result.symbol).toBe('BRCA1');
  });

  test('geneGet() smart mode sorts alias hits by _id for deterministic ordering', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // Two hits with same alias, different _id (entrezgene)
        // The one with lower _id should be preferred
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [
              {
                _id: '9999',
                symbol: 'LATER_GENE',
                alias: ['shared_alias'],
              },
              {
                _id: '100',
                symbol: 'EARLIER_GENE',
                alias: ['shared_alias'],
              },
            ],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // Resolved lookup
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            symbol: 'EARLIER_GENE',
            name: 'Earlier Gene',
            summary: 'A gene.',
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('shared_alias', undefined, true);

    // Lower _id = 100 should be picked first
    expect(result.symbol).toBe('EARLIER_GENE');
  });
});

// ============================================================
// geneGet core only (no sections)
// ============================================================
describe('geneGet core only', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() without sections returns core fields only', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          symbol: 'TP53',
          name: 'Tumor protein p53',
          summary: 'A tumor suppressor gene.',
        }],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('TP53');

    expect(result.symbol).toBe('TP53');
    expect(result.name).toBe('Tumor protein p53');
    expect(result.summary).toBe('A tumor suppressor gene.');
    expect(result.sections).toBeUndefined();
  });
});

// ============================================================
// geneGet with GO section
// ============================================================
describe('geneGet with GO section', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() fetches GO terms and categorizes by aspect', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // GO section fetch via mygene
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            go: {
              BP: [
                { id: 'GO:0006915', term: 'apoptotic process' },
                { id: 'GO:0008283', term: 'cell population proliferation' },
              ],
              MF: [
                { id: 'GO:0003700', term: 'DNA-binding transcription factor activity' },
              ],
              CC: [
                { id: 'GO:0005634', term: 'nucleus' },
              ],
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['go']);

    expect(Object.keys(result.sections!)).toEqual(['go']);
    const goTerms = result.sections!.go as Array<{ id: string; term: string; aspect: string }>;
    expect(goTerms.length).toBe(4);
    expect(goTerms.some(t => t.aspect === 'BP')).toBe(true);
    expect(goTerms.some(t => t.aspect === 'MF')).toBe(true);
    expect(goTerms.some(t => t.aspect === 'CC')).toBe(true);
  });

  // Regression for GitHub issue #199: mygene serves BP/MF/CC as orthogonal
  // facets, but the old BP→MF→CC concat + 50-row cap structurally starved
  // MF/CC for well-annotated genes (live: TP53's BP list alone exceeds the
  // cap). The three aspects are now interleaved round-robin BEFORE the cap,
  // so every prefix of the result is balanced.
  test('geneGet() GO section interleaves aspects round-robin so MF/CC are not starved at TP53 scale', async () => {
    const goIds = (base: number, n: number, label: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `GO:${String(base + i)}`,
        term: `${label} term ${i}`,
      }));
    // 60 BP / 30 MF / 15 CC — TP53-scale annotation counts (issue #199).
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [tp53TumorSuppressorHit] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            go: {
              BP: goIds(2000000, 60, 'BP'),
              MF: goIds(3000000, 30, 'MF'),
              CC: goIds(4000000, 15, 'CC'),
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['go']);

    const goTerms = result.sections!.go as Array<{ id: string; term: string; aspect: string }>;
    // Internal cap still applied.
    expect(goTerms).toHaveLength(50);
    // No duplicates survived to the capped result.
    expect(new Set(goTerms.map(t => t.id)).size).toBe(50);

    const aspectCounts = (n: number): Record<string, number> => {
      const counts: Record<string, number> = { BP: 0, MF: 0, CC: 0 };
      for (const t of goTerms.slice(0, n)) counts[t.aspect]++;
      return counts;
    };
    // Prefix 10 (a consumer showing 10 rows): every aspect is represented.
    const at10 = aspectCounts(10);
    expect(at10.BP).toBeGreaterThanOrEqual(2);
    expect(at10.MF).toBeGreaterThanOrEqual(2);
    expect(at10.CC).toBeGreaterThanOrEqual(2);
    // Prefix 30: exactly balanced (10 per aspect; tolerance ±1 in the spec,
    // deterministic exact here because every list has ≥10 entries).
    const at30 = aspectCounts(30);
    expect(at30.BP).toBe(10);
    expect(at30.MF).toBe(10);
    expect(at30.CC).toBe(10);
    // At the 50-row internal cap MF and CC are still present despite BP
    // being 4x their size — the old order would have been 50 BP rows.
    const atCap = aspectCounts(50);
    expect(atCap.BP).toBe(18);
    expect(atCap.MF).toBe(17);
    expect(atCap.CC).toBe(15);
    // The interleave itself: BP[0], MF[0], CC[0] lead the result.
    expect(goTerms.slice(0, 3).map(t => t.aspect)).toEqual(['BP', 'MF', 'CC']);
  });

  // Regression for GitHub issue #135 (part 4): MyGene repeats GO ids within
  // and across categories (live: TP53 shows 46 duplicated ids among ~130
  // annotations), and the old collect-then-slice let duplicates displace
  // unique terms from the 50-row cap. Dedup happens on GO id BEFORE the
  // slice now (same seen-set idiom as the ontology section). Scaled past the
  // cap (57 unique ids > 50 rows) so the slice is genuinely exercised.
  test('geneGet() GO section dedupes repeated term ids so no unique term is displaced from the 50-row cap', async () => {
    const dup = { id: 'GO:0000122', term: 'negative regulation of transcription by RNA polymerase II' };
    const bpUniques = Array.from({ length: 55 }, (_, i) => ({
      id: `GO:${String(1000000 + i)}`,
      term: `BP unique term ${i}`,
    }));
    const mfUnique = { id: 'GO:0009999', term: 'MF unique term' };
    const ccUnique = { id: 'GO:0008888', term: 'CC unique term' };
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [tp53TumorSuppressorHit] }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // 58 raw items (dup listed twice), 57 unique ids — more than the
      // 50-row cap, so without the dedup the duplicate would occupy a capped
      // slot and displace a unique term.
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            go: {
              BP: [dup, ...bpUniques, { ...dup }],
              MF: [mfUnique],
              CC: [ccUnique],
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['go']);

    const goTerms = result.sections!.go as Array<{ id: string; term: string; aspect: string }>;
    expect(goTerms).toHaveLength(50);
    // No repeated ids at all.
    const ids = goTerms.map(t => t.id);
    expect(new Set(ids).size).toBe(50);
    // The duplicate appears exactly once, under its first-seen category.
    expect(ids.filter(id => id === 'GO:0000122')).toHaveLength(1);
    expect(goTerms.find(t => t.id === 'GO:0000122')!.aspect).toBe('BP');
    // The last-collected CC term survived the cap — proving dedup ran first.
    expect(goTerms.some(t => t.id === 'GO:0008888' && t.aspect === 'CC')).toBe(true);
  });
});

// ============================================================
// geneGet with interactions section
// ============================================================
describe('geneGet with interactions section', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() fetches protein-protein interactions from STRING', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // STRING interactions
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { preferredName_B: 'MDM2', score: 0.999 },
          { preferredName_B: 'BRCA1', score: 0.956 },
        ]),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['interactions']);

    expect(result.sections).toBeDefined();
    const interactions = result.sections!.interactions as Array<{ symbol: string; score: number; source: string }>;
    expect(interactions.length).toBe(2);
    expect(interactions[0].symbol).toBe('MDM2');
    expect(interactions[0].source).toBe('string');
    expect(interactions[1].score).toBe(0.956);
  });
});

// ============================================================
// geneGet with civic section
// ============================================================
describe('geneGet with civic section', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() fetches CIViC clinical variants', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [{
              symbol: 'BRAF',
              name: 'B-Raf proto-oncogene',
              summary: 'Serine/threonine kinase.',
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // CIViC GraphQL response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            gene: {
              id: 5,
              name: 'BRAF',
              variants: {
                nodes: [
                  { id: 12, name: 'V600E' },
                  { id: 33, name: 'K601E' },
                ],
              },
            },
          },
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRAF', ['civic']);

    expect(Object.keys(result.sections!)).toEqual(['civic']);
    const civic = result.sections!.civic as { variants: Array<{ name: string }> };
    expect(civic.variants).toHaveLength(2);
    expect(civic.variants.map(v => v.name)).toEqual(['V600E', 'K601E']);
  });
});

// ============================================================
// geneGet with unknown section
// ============================================================
describe('geneGet with unknown section', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() handles unknown section name gracefully', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [tp53TumorSuppressorHit],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('TP53', ['unknown_section_xyz']);

    expect(result.symbol).toBe('TP53');
    expect(result.sections).toBeDefined();
    // Unknown section should still be present but with null data
    expect(result.sections!.unknown_section_xyz).toBeNull();
  });
});

// ============================================================
// geneGet with clingen section (stub)
// ============================================================
describe('geneGet with clingen section', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() clingen returns error about no public API', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [brca1DnaRepairHit],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('BRCA1', ['clingen']);

    expect(Object.keys(result.sections!)).toEqual(['clingen']);
    expect(result.sections!.clingen).toMatchObject({
      _error: expect.stringMatching(/ClinGen.*not available via public API/s),
    });
  });
});

// ============================================================
// geneGet with constraint section (gnomad)
// ============================================================
describe('geneGet with constraint section', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() fetches gnomAD constraint scores', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // gnomAD GraphQL response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: {
            gene: {
              gnomad_constraint: {
                oe_lof: 0.08,
                oe_lof_upper: 0.12,
                oe_mis: 0.76,
                oe_syn: 0.98,
              },
            },
          },
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['constraint']);

    expect(Object.keys(result.sections!)).toEqual(['constraint']);
    const constraint = result.sections!.constraint as any;
    expect(constraint.lof).toEqual({ oe_score: 0.08, oe_lof_upper: 0.12, mis_bad_loe: 0.76 });
    expect(constraint.syn).toEqual({ oe_score: 0.98 });
  });
});

// ============================================================
// geneGet with disgenet section (no API key)
// ============================================================
describe('geneGet with disgenet section', () => {
  mockGlobalFetch();
  let originalEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = process.env.DISGENET_API_KEY;
    delete process.env.DISGENET_API_KEY;
    connectionManager.closeAll();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DISGENET_API_KEY = originalEnv;
    }
  });

  test('geneGet() disgenet returns error when DISGENET_API_KEY not set', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [brca1DnaRepairHit],
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }) as any;

    const result = await geneGet('BRCA1', ['disgenet']);

    expect(result.sections).toBeDefined();
    const disgenet = result.sections!.disgenet as any;
    expect(disgenet._error).toContain('DISGENET_API_KEY');
  });

  test('geneGet() diseases section surfaces _error (underscore shape) when OpenTargets fails', async () => {
    // Section-level failures must land as `{ _error }` — the underscore-less
    // `{ error }` writer shape escaped every `'_error' in section` check
    // (issue #84).
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mygene.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      return Promise.reject(new Error('OpenTargets unreachable'));
    }) as any;

    const result = await geneGet('TP53', ['diseases']);

    expect(result.sections).toBeDefined();
    const diseases = result.sections!.diseases as { _error: string };
    expect(diseases._error).toBeDefined();
    expect(diseases._error).toContain('Disease association lookup failed');
    expect(diseases._error).toContain('OpenTargets unreachable');
  });
});

// ============================================================
// gene_diseases tool: OpenTargets fallback contract (issue #84)
// ============================================================
describe('gene_diseases tool fallback contract (issue #84)', () => {
  let harness: McpTestHarness;
  mockGlobalFetch();
  let originalEnv: string | undefined;

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = process.env.DISGENET_API_KEY;
    delete process.env.DISGENET_API_KEY;
    connectionManager.closeAll();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DISGENET_API_KEY = originalEnv;
    } else {
      delete process.env.DISGENET_API_KEY;
    }
  });

  test('keyless: returns OpenTargets-sourced diseases via the fallback', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mygene.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (url.hostname === 'api.platform.opentargets.org') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: {
              search: { hits: [{ id: 'ENSG00000141510', name: 'TP53', entity: 'target' }] },
              target: {
                associatedDiseases: {
                  rows: [
                    { disease: { id: 'MONDO:0002051', name: 'squamous cell carcinoma' }, score: 0.9 },
                    { disease: { id: 'MONDO:0004989', name: 'colorectal cancer' }, score: 0.8 },
                  ],
                },
              },
            },
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url.href}`));
    }) as any;

    const result = await harness.callTool('gene_diseases', { symbol: 'TP53' });

    expect(result).toEqual([
      { name: 'squamous cell carcinoma', source: 'opentargets' },
      { name: 'colorectal cancer', source: 'opentargets' },
    ]);
  });

  test('keyless + OpenTargets failing: isError names BOTH failure reasons', async () => {
    // Error swallowing fix (issue #84): when both legs fail, the reply must
    // combine the DisGeNET and OpenTargets reasons — never drop the OT one.
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mygene.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      return Promise.reject(new Error('OpenTargets unreachable'));
    }) as any;

    await expect(harness.callTool('gene_diseases', { symbol: 'TP53' })).rejects.toThrow(
      /DisGeNET unavailable \(.*DISGENET_API_KEY.*\); OpenTargets fallback also failed \(.*OpenTargets unreachable.*\)/s
    );
  });

  test('keyed: DisGeNET associations win when present (no fallback)', async () => {
    process.env.DISGENET_API_KEY = 'test-disgenet-key';
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mygene.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (url.hostname === 'api.disgenet.com') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            payload: [{ symbolOfGene: 'TP53', diseaseName: 'Breast carcinoma', score: 0.9, numPMIDs: 12 }],
            warnings: [],
            pageNum: 0,
            pageSize: 10,
            pageCount: 1,
            totalEntries: 1,
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url.href}`));
    }) as any;

    const result = await harness.callTool('gene_diseases', { symbol: 'TP53' });

    expect(result).toEqual(['Breast carcinoma']);
  });
});

// ============================================================
// geneGet with disgenet section (keyed)
// ============================================================
describe('geneGet with disgenet section (keyed)', () => {
  mockGlobalFetch();
  let originalEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = process.env.DISGENET_API_KEY;
    process.env.DISGENET_API_KEY = 'test-disgenet-key';
    connectionManager.closeAll();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DISGENET_API_KEY = originalEnv;
    } else {
      delete process.env.DISGENET_API_KEY;
    }
  });

  test('geneGet() disgenet queries gda/summary with gene_symbol and raw Authorization key', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // mygene lookup
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [brca1DnaRepairHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // DisGeNET gda/summary response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          payload: [
            {
              symbolOfGene: 'BRCA1',
              geneNcbiID: 672,
              diseaseName: 'Breast carcinoma',
              diseaseUMLSCUI: 'C0006142',
              score: 0.9,
              numPMIDs: 120,
            },
          ],
          warnings: [],
          pageNum: 0,
          pageSize: 10,
          pageCount: 1,
          totalEntries: 1,
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('BRCA1', ['disgenet']);

    const calls = (global.fetch as any).mock.calls;
    expect(calls.length).toBe(2);
    const url = new URL(calls[1][0] as string);
    expect(url.origin + url.pathname).toBe('https://api.disgenet.com/api/v1/gda/summary');
    expect(url.searchParams.get('gene_symbol')).toBe('BRCA1');
    expect(url.searchParams.get('page_number')).toBe('0');
    // Raw (unprefixed) API key in Authorization header.
    expect((calls[1][1].headers as Headers).get('Authorization')).toBe('test-disgenet-key');

    const disgenet = result.sections!.disgenet as any;
    expect(disgenet.associations).toEqual([
      { disease_name: 'Breast carcinoma', score: 0.9, pmids: 120, source: 'disgenet' },
    ]);
  });
});

// ============================================================
// geneGet with ontology section
// ============================================================
describe('geneGet with ontology section', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() fetches ontology enrichment data', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [tp53TumorSuppressorHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // mygene GO response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          hits: [{
            go: {
              BP: [
                { id: 'GO:0006915', term: 'apoptotic process' },
              ],
              MF: [
                { id: 'GO:0003700', term: 'DNA-binding transcription factor activity' },
              ],
              CC: [
                { id: 'GO:0005634', term: 'nucleus' },
              ],
            },
          }],
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    const result = await geneGet('TP53', ['ontology']);

    expect(Object.keys(result.sections!)).toEqual(['ontology']);
    const ontology = result.sections!.ontology as { go_enrichment: Array<{ id: string; term: string }> };
    expect(ontology.go_enrichment).toHaveLength(3);
    // BP/MF/CC each contribute their single mocked term, in category order.
    expect(ontology.go_enrichment.map(t => t.id)).toEqual(['GO:0006915', 'GO:0003700', 'GO:0005634']);
  });
});

// ============================================================
// geneGet multiple sections with partial failure
// ============================================================
describe('geneGet multiple sections with partial success and failure', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() returns mix of successful and failed sections', async () => {
    let callIndex = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        // Gene lookup
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            hits: [brca1DnaRepairHit],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (callIndex === 2) {
        // pathways section: success
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            results: [{
              entries: [{
                type: 'Pathway',
                stId: 'R-HSA-1',
                name: 'Test Pathway',
              }],
            }],
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      // protein section: failure
      return Promise.reject(new Error('UniProt is down'));
    }) as any;

    const result = await geneGet('BRCA1', ['pathways', 'protein']);

    // Pathways should succeed
    const pathways = result.sections!.pathways as Array<{ id: string; name: string; source: string }>;
    expect(pathways).toHaveLength(1);
    expect(pathways[0].name).toBe('Test Pathway');

    // Protein should have error (fetchProtein catches internally and returns { _error })
    const proteinError = result.sections!.protein as { _error: string };
    expect(proteinError._error).toContain('Protein lookup failed');
  });
});

// ============================================================
// transformMyGeneResponse additional tests
// ============================================================
describe('transformMyGeneResponse edge cases', () => {
  test('handles missing summary', () => {
    const input = { symbol: 'TP53', name: 'Tumor protein p53' };
    const result = transformMyGeneResponse(input);
    expect(result.summary).toBeUndefined();
  });
});

// ============================================================
// geneGet with expression section (GTEx v10)
// ============================================================
describe('geneGet with expression section', () => {
  mockGlobalFetch();

  const GTEx_DATASETS = [
    { datasetId: 'gtex_v8', displayName: 'GTEx Analysis v8', gencodeVersion: 'v26', genomeBuild: 'GRCh38/hg38' },
    { datasetId: 'kids_first_harmonization', displayName: "Kid's First", gencodeVersion: 'v26', genomeBuild: 'GRCh38/hg38' },
    { datasetId: 'gtex_v10', displayName: 'GTEx Analysis v10', gencodeVersion: 'v39', genomeBuild: 'GRCh38/hg38' },
  ];
  const GTEx_GENE_SEARCH = {
    data: [
      { gencodeId: 'ENSG00000143514.17', geneSymbol: 'TP53BP2', geneSymbolUpper: 'TP53BP2' },
      { gencodeId: 'ENSG00000115129.14', geneSymbol: 'TP53I3', geneSymbolUpper: 'TP53I3' },
      { gencodeId: 'ENSG00000141510.18', geneSymbol: 'TP53', geneSymbolUpper: 'TP53', entrezGeneId: 7157 },
    ],
    paging_info: { numberOfPages: 1, page: 0, maxItemsPerPage: 250, totalNumberOfItems: 3 },
  };
  const GTEx_MEDIAN = {
    data: [
      { median: 22.65, tissueSiteDetailId: 'Adipose_Subcutaneous', ontologyId: 'UBERON:0002190', unit: 'TPM' },
      { median: 12.03, tissueSiteDetailId: 'Whole_Blood', ontologyId: 'UBERON:0000178', unit: 'TPM' },
      { median: 5.12, tissueSiteDetailId: 'Muscle_Skeletal', ontologyId: 'UBERON:0002378', unit: 'TPM' },
    ],
  };

  function okJson(body: unknown) {
    return {
      ok: true,
      json: () => Promise.resolve(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('geneGet() expression section returns GTEx tissues as {tissue, tpm}', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
      if (parseMockUrl(rawUrl).hostname === 'mygene.info') {
        return Promise.resolve(okJson({
          hits: [tp53TumorSuppressorHit],
        }));
      }
      if (rawUrl.includes('metadata/dataset')) return Promise.resolve(okJson(GTEx_DATASETS));
      if (rawUrl.includes('geneSearch')) return Promise.resolve(okJson(GTEx_GENE_SEARCH));
      if (rawUrl.includes('medianGeneExpression')) return Promise.resolve(okJson(GTEx_MEDIAN));
      return Promise.resolve(okJson({}));
    }) as any;

    const result = await geneGet('TP53', ['expression']);

    expect(result.sections).toBeDefined();
    const expression = result.sections!.expression as { tissues: Array<{ tissue: string; tpm: number }> };
    expect(expression.tissues[0]).toEqual({ tissue: 'Adipose_Subcutaneous', tpm: 22.65 });
    expect(expression.tissues.map(t => t.tissue)).toEqual(['Adipose_Subcutaneous', 'Whole_Blood', 'Muscle_Skeletal']);

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
    const medianUrl = urls.find((u: any) => u.includes('medianGeneExpression'));
    expect(medianUrl).toContain('gencodeId=ENSG00000141510.18');
    expect(medianUrl).toContain('datasetId=gtex_v10');
  });

  test('geneGet() expression section surfaces _error when gene is not in GTEx', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
      if (parseMockUrl(rawUrl).hostname === 'mygene.info') {
        return Promise.resolve(okJson({
          hits: [{ symbol: 'NOGTEX1', name: 'Not in GTEx', summary: 'A gene.' }],
        }));
      }
      if (rawUrl.includes('metadata/dataset')) return Promise.resolve(okJson(GTEx_DATASETS));
      if (rawUrl.includes('geneSearch')) {
        return Promise.resolve(okJson({ data: [], paging_info: { numberOfPages: 0 } }));
      }
      return Promise.resolve(okJson({}));
    }) as any;

    const result = await geneGet('NOGTEX1', ['expression']);

    const expression = result.sections!.expression as { _error: string };
    // Since #132 the gtex entity returns a structured envelope instead of
    // throwing; the section surfaces that envelope's message verbatim.
    expect(expression._error).toContain('GTEx request failed');
    expect(expression._error).toContain("Gene 'NOGTEX1' not found in GTEx v10");
  });

  test('geneGet() expression section surfaces _error for empty median data', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
      if (parseMockUrl(rawUrl).hostname === 'mygene.info') {
        return Promise.resolve(okJson({
          hits: [tp53TumorSuppressorHit],
        }));
      }
      if (rawUrl.includes('metadata/dataset')) return Promise.resolve(okJson(GTEx_DATASETS));
      if (rawUrl.includes('geneSearch')) return Promise.resolve(okJson(GTEx_GENE_SEARCH));
      if (rawUrl.includes('medianGeneExpression')) return Promise.resolve(okJson({ data: [] }));
      return Promise.resolve(okJson({}));
    }) as any;

    const result = await geneGet('TP53', ['expression']);

    const expression = result.sections!.expression as { _error: string };
    expect(expression._error).toContain('No GTEx expression data found');
    expect(expression._error).toContain('ENSG00000141510.18');
  });
});

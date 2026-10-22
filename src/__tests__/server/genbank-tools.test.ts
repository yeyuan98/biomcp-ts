import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function nuccoreDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: '1234',
    caption: 'NC_000023',
    title: 'Homo sapiens chromosome 23, GRCh38.p14',
    slen: 1000,
    taxid: 9606,
    organism: 'Homo sapiens',
    biomol: 'genomic',
    topology: 'linear',
    sourcedb: 'refseq',
    subtype: 'chromosome',
    subname: '23',
    accessionversion: 'NC_000023.11',
    createdate: '2020/01/01',
    updatedate: '2023/06/01',
    ...overrides,
  };
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  };
}

function okText(text: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/plain' }),
    text: () => Promise.resolve(text),
  };
}

type RouteHandler = (url: URL) => unknown;

function mockFetchRoutes(routes: Record<string, RouteHandler>): void {
  global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.href.startsWith(prefix)) {
        const result = handler(url) as unknown;
        if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
          return Promise.resolve(result);
        }
        return Promise.resolve(okJson(result));
      }
    }
    return Promise.resolve(okJson({}));
  }) as any;
}

function defaultRoutes(overrides: {
  esearchIds?: string[];
  efetchText?: string;
  geneLinks?: string[];
} = {}): Record<string, RouteHandler> {
  return {
    [`${EUTILS}/esearch.fcgi`]: () => ({
      esearchresult: { count: '1', idlist: overrides.esearchIds ?? ['1234'] },
    }),
    [`${EUTILS}/esummary.fcgi`]: url => {
      // genbankGet/genbankToGeneIds call esummary with the accession itself;
      // genbankSearch calls it with numeric uids from esearch. Map both.
      const uidByRequestedId: Record<string, string> = {
        '1234': '1234',
        'NC_000023.11': '1234',
        '5678': '5678',
        'NG_017013.2': '5678',
      };
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const uids = ids.map(id => uidByRequestedId[id]).filter(Boolean);
      const result: Record<string, unknown> = { uids };
      if (uids.includes('1234')) result['1234'] = nuccoreDoc();
      if (uids.includes('5678')) result['5678'] = nuccoreDoc({ uid: '5678', accessionversion: 'NG_017013.2', caption: 'NG_017013' });
      return { result };
    },
    [`${EUTILS}/efetch.fcgi`]: () => okText(overrides.efetchText ?? 'LOCUS       NC_000023\nORIGIN\n//'),
    [`${EUTILS}/elink.fcgi`]: () => ({
      linksets: [{
        dbfrom: 'nuccore',
        ids: ['1234'],
        linksetdbs: [{ dbto: 'gene', linkname: 'nuccore_gene', links: overrides.geneLinks ?? ['7157', '29087'] }],
      }],
    }),
  };
}

function fetchUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

describe('genbank tools', () => {
  let harness: McpTestHarness;
  mockGlobalFetch();

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  it('genbank_search maps nuccore esummary docs', async () => {
    mockFetchRoutes(defaultRoutes());

    const results = (await harness.callTool('genbank_search', { query: 'TP53[Gene Name] AND Homo sapiens[Organism]' })) as any[];

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      accession: 'NC_000023.11',
      organism: 'Homo sapiens',
      length_bp: 1000,
      topology: 'linear',
      chromosome: '23',
    });
  });

  it('genbank_get passes region params to efetch and echoes the region', async () => {
    mockFetchRoutes(defaultRoutes({ efetchText: '>NC_000023.11:1-60\nACGT\n' }));

    const record = (await harness.callTool('genbank_get', {
      accession: 'NC_000023.11',
      format: 'fasta',
      seq_start: 1,
      seq_stop: 60,
    })) as any;

    expect(record).toMatchObject({
      accession: 'NC_000023.11',
      format: 'fasta',
      sequence_text: '>NC_000023.11:1-60\nACGT\n',
      region: { start: 1, stop: 60, strand: 1 },
      char_count: '>NC_000023.11:1-60\nACGT\n'.length,
      total_char_count: '>NC_000023.11:1-60\nACGT\n'.length,
      truncated: false,
    });
    expect(record.mode).toBeUndefined();

    const efetchUrl = fetchUrls().find(u => u.includes('efetch.fcgi'))!;
    const parsed = new URL(efetchUrl);
    expect(parsed.searchParams.get('rettype')).toBe('fasta');
    expect(parsed.searchParams.get('seq_start')).toBe('1');
    expect(parsed.searchParams.get('seq_stop')).toBe('60');
  });

  it('genbank_get rejects malformed accessions at the schema level (issue #163)', async () => {
    mockFetchRoutes(defaultRoutes());

    // Formerly an entity-layer "Invalid GenBank accession" error; the shape
    // check moved to the zod schema, so malformed input now fails as an
    // MCP -32602 with the expected-shape message and zero fetches.
    await expect(harness.callTool('genbank_get', { accession: 'not an accession!!' })).rejects.toThrow(
      /Accession must look like NC_000023\.11, NG_017013\.2, KJ668569\.1, or U12345/
    );
    expect(fetchUrls()).toHaveLength(0);
  });

  it('genbank_genes returns NCBI Gene IDs with the MyGene bridge note', async () => {
    mockFetchRoutes(defaultRoutes());

    const result = (await harness.callTool('genbank_genes', { accession: 'NC_000023.11' })) as any;

    expect(result).toEqual({
      gene_ids: [7157, 29087],
      note: 'NCBI Gene IDs (entrezgene) — resolve to an HGNC symbol via gene_search before gene_get',
    });
  });

  describe('genbank_get output modes (file store)', () => {
    let savedCacheDir: string | undefined;
    let cacheRoot: string;

    beforeEach(() => {
      savedCacheDir = process.env.BIOMCP_CACHE_DIR;
      cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-gbtools-'));
      process.env.BIOMCP_CACHE_DIR = cacheRoot;
    });

    afterEach(() => {
      if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
      else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
      rmSync(cacheRoot, { recursive: true, force: true });
    });

    it('small records (<=1k chars) stay inline with honest counts and no file written', async () => {
      const text = 'LOCUS       NC_000023\nORIGIN\n//';
      mockFetchRoutes(defaultRoutes({ efetchText: text }));

      const record = (await harness.callTool('genbank_get', { accession: 'NC_000023.11' })) as any;

      expect(record.sequence_text).toBe(text);
      expect(record.truncated).toBe(false);
      expect(record.char_count).toBe(text.length);
      expect(record.total_char_count).toBe(text.length);
      expect(record.mode).toBeUndefined();
      expect(existsSync(join(cacheRoot, 'genbank'))).toBe(false);
    });

    it('large records default to file mode: full text on disk, handle in the reply', async () => {
      const text = `LOCUS       NC_000023\n${'ACGT'.repeat(1500)}\n//`;
      expect(text.length).toBeGreaterThan(1_000);
      mockFetchRoutes(defaultRoutes({ efetchText: text }));

      const record = (await harness.callTool('genbank_get', { accession: 'NC_000023.11' })) as any;

      expect(record.sequence_text).toBeUndefined();
      expect(record.mode).toBe('file');
      expect(record.file_path).toBe(join(cacheRoot, 'genbank', 'NC_000023.11.genbank'));
      expect(record.char_count).toBe(text.length);
      expect(record.total_char_count).toBe(text.length);
      expect(record.truncated).toBe(false);
      expect(record.length_bp).toBe(1000);
      expect(record.note).toContain('server-local');
      // The file carries the FULL text — never truncated.
      expect(readFileSync(record.file_path, 'utf8')).toBe(text);
    });

    it('sequence_output:"inline" opts a large record back into the old 200k-cap behavior', async () => {
      const oversized = 'A'.repeat(250_000);
      mockFetchRoutes(defaultRoutes({ efetchText: oversized }));

      const record = (await harness.callTool('genbank_get', {
        accession: 'NC_000023.11',
        sequence_output: 'inline',
      })) as any;

      const expectedMarker =
        '\n...[truncated 50000 of 250000 chars — request a seq_start/seq_stop region for the full text]';
      expect(record.sequence_text).toBe('A'.repeat(200_000) + expectedMarker);
      expect(record.truncated).toBe(true);
      expect(record.total_char_count).toBe(250_000);
      expect(record.mode).toBeUndefined();
      expect(existsSync(join(cacheRoot, 'genbank'))).toBe(false);
    });

    it('store failure falls back to truncated inline output, disclosed', async () => {
      // A cache dir under a regular file cannot be created — every store
      // write fails, so the tool must fall back rather than error.
      const blocker = join(cacheRoot, 'blocker');
      writeFileSync(blocker, 'x');
      process.env.BIOMCP_CACHE_DIR = join(blocker, 'nested');

      const oversized = 'A'.repeat(250_000);
      mockFetchRoutes(defaultRoutes({ efetchText: oversized }));

      const record = (await harness.callTool('genbank_get', { accession: 'NC_000023.11' })) as any;

      expect(record.sequence_text).toContain('truncated 50000 of 250000 chars');
      expect(record.sequence_text.startsWith('A'.repeat(200_000))).toBe(true);
      expect(record.truncated).toBe(true);
      expect(record.mode).toBeUndefined();
      expect(record.note).toContain('File output was requested but unavailable');
    });

    it('region requests produce per-region file names', async () => {
      const text = `>NC_000023.11 region\n${'ACGT'.repeat(400)}\n`;
      mockFetchRoutes(defaultRoutes({ efetchText: text }));

      const first = (await harness.callTool('genbank_get', {
        accession: 'NC_000023.11',
        format: 'fasta',
        seq_start: 1,
        seq_stop: 100,
      })) as any;
      const second = (await harness.callTool('genbank_get', {
        accession: 'NC_000023.11',
        format: 'fasta',
        seq_start: 101,
        seq_stop: 200,
        strand: 2,
      })) as any;

      expect(first.file_path).toBe(join(cacheRoot, 'genbank', 'NC_000023.11.fasta_r1-100_s1'));
      expect(second.file_path).toBe(join(cacheRoot, 'genbank', 'NC_000023.11.fasta_r101-200_s2'));
      expect(first.file_path).not.toBe(second.file_path);
      expect(existsSync(first.file_path)).toBe(true);
      expect(existsSync(second.file_path)).toBe(true);
    });
  });
});

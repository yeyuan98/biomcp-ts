import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { createMcpTestHarness, type McpTestHarness } from '../helpers/mcp-harness.js';

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
  global.fetch = jest.fn().mockImplementation((rawUrl: string) => {
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
  let originalFetch: typeof global.fetch;

  beforeAll(async () => {
    harness = await createMcpTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
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
    });

    const efetchUrl = fetchUrls().find(u => u.includes('efetch.fcgi'))!;
    const parsed = new URL(efetchUrl);
    expect(parsed.searchParams.get('rettype')).toBe('fasta');
    expect(parsed.searchParams.get('seq_start')).toBe('1');
    expect(parsed.searchParams.get('seq_stop')).toBe('60');
  });

  it('genbank_get truncates oversized sequence_text with a truncation marker', async () => {
    const oversized = 'A'.repeat(250_000);
    mockFetchRoutes(defaultRoutes({ efetchText: oversized }));

    const record = (await harness.callTool('genbank_get', {
      accession: 'NC_000023.11',
    })) as any;

    const expectedMarker =
      '\n...[truncated 50000 of 250000 chars — request a seq_start/seq_stop region for the full text]';
    expect(record.sequence_text).toBe('A'.repeat(200_000) + expectedMarker);
    expect(record.sequence_text).toContain('request a seq_start/seq_stop region');
  });

  it('genbank_get surfaces entity validation errors for malformed accessions', async () => {
    mockFetchRoutes(defaultRoutes());

    await expect(harness.callTool('genbank_get', { accession: 'not an accession!!' })).rejects.toThrow(
      /Invalid GenBank accession/
    );
  });

  it('genbank_genes returns NCBI Gene IDs with the MyGene bridge note', async () => {
    mockFetchRoutes(defaultRoutes());

    const result = (await harness.callTool('genbank_genes', { accession: 'NC_000023.11' })) as any;

    expect(result).toEqual({
      gene_ids: [7157, 29087],
      note: 'NCBI Gene IDs — usable as entrezgene IDs with MyGene tools',
    });
  });
});

import { jest } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';

const GB_TEXT = [
  'LOCUS       NG_017013            32772 bp    DNA     linear   CON 07-APR-2010',
  'DEFINITION  Homo sapiens tumor protein p53 (TP53), RefSeqGene (LRG_321) on chromosome 17.',
  'ORIGIN      ',
  '        1 gggcctgggc cctgggcctg',
  '//',
].join('\n');

const FASTA_TEXT = '>NG_017013.2 Homo sapiens tumor protein p53 (TP53), RefSeqGene (LRG_321)\nGGGCCTGGGCCCUGGGCC\n';

const ESUMMARY_DOCS: Record<string, Record<string, unknown>> = {
  NG_017013: {
    uid: '383209646',
    caption: 'NG_017013',
    title: 'Homo sapiens tumor protein p53 (TP53), RefSeqGene (LRG_321) on chromosome 17',
    slen: 32772,
    taxid: 9606,
    organism: 'Homo sapiens',
    biomol: 'genomic',
    topology: 'linear',
    sourcedb: 'refseq',
    subtype: 'chromosome|map',
    subname: '17|17p13.1',
    accessionversion: 'NG_017013.2',
    createdate: '2010/04/07',
    updatedate: '2026/07/17',
  },
  NC_000001: {
    uid: '568815597',
    caption: 'NC_000001',
    title: 'Homo sapiens chromosome 1, GRCh38.p14 Primary Assembly',
    slen: 248956422,
    taxid: 9606,
    organism: 'Homo sapiens',
    biomol: 'genomic',
    topology: 'linear',
    sourcedb: 'refseq',
    subtype: 'chromosome',
    subname: '1',
    accessionversion: 'NC_000001.11',
    createdate: '2013/06/28',
    updatedate: '2024/04/03',
  },
  NC_000023: {
    uid: '568815581',
    caption: 'NC_000023',
    title: 'Homo sapiens chromosome X, GRCh38.p14 Primary Assembly',
    slen: 156040895,
    taxid: 9606,
    organism: 'Homo sapiens',
    biomol: 'genomic',
    topology: 'linear',
    sourcedb: 'refseq',
    subtype: 'chromosome',
    subname: 'X',
    accessionversion: 'NC_000023.11',
    createdate: '2013/06/28',
    updatedate: '2024/04/03',
  },
  CM000663: {
    uid: '999000111',
    caption: 'CM000663',
    title: 'Homo sapiens chromosome CM000663, complete genome',
    slen: 5000000,
    taxid: 9606,
    organism: 'Homo sapiens',
    biomol: 'genomic',
    topology: 'linear',
    sourcedb: 'insd',
    accessionversion: 'CM000663.2',
    createdate: '2021/01/01',
    updatedate: '2021/01/01',
  },
};

// Batch esummary docs for search — uids order deliberately differs from the
// esearch idlist order to prove results keep esearch ordering.
const SEARCH_UID_DOCS: Record<string, Record<string, unknown>> = {
  '100': { uid: '100', caption: 'NG_017013', title: 'TP53 RefSeqGene', slen: 32772, taxid: 9606, organism: 'Homo sapiens', biomol: 'genomic', topology: 'linear', sourcedb: 'refseq', subtype: 'chromosome|map', subname: '17|17p13.1', accessionversion: 'NG_017013.2', updatedate: '2026/07/17' },
  '200': { uid: '200', caption: 'U12345', title: 'Human mRNA clone', slen: 1500, taxid: 9606, organism: 'Homo sapiens', biomol: 'mRNA', topology: 'linear', sourcedb: 'insd', accessionversion: 'U12345.1', updatedate: '1994/03/01' },
};

const ESEARCH_RESPONSE = { esearchresult: { count: '2', idlist: ['200', '100'] } };

const ELINK_WITH_GENE = {
  linksets: [{
    dbfrom: 'nuccore',
    ids: ['383209646'],
    linksetdbs: [{ dbto: 'gene', linkname: 'nuccore_gene', links: ['7157'] }],
  }],
};

const ELINK_EMPTY = { linksets: [{ dbfrom: 'nuccore', ids: ['383209646'] }] };

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
}

function okText(body: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'text/plain' }),
  };
}

function esummaryHandler(url: URL): ReturnType<typeof okJson> {
  const id = url.searchParams.get('id') || '';
  if (id.includes(',')) {
    const uids = id.split(',');
    const result: Record<string, unknown> = { uids };
    for (const uid of uids) result[uid] = SEARCH_UID_DOCS[uid] ?? {};
    return okJson({ header: { type: 'esummary', version: '0.3' }, result });
  }
  const doc = ESUMMARY_DOCS[id.split('.')[0]];
  if (!doc) {
    return okJson({ header: { type: 'esummary', version: '0.3' }, result: { error: `Invalid uid ${id} at position= 0` } });
  }
  return okJson({ header: { type: 'esummary', version: '0.3' }, result: { uids: [String(doc.uid)], [String(doc.uid)]: doc } });
}

type RouteHandler = (url: URL) => unknown;

function mockFetchRoutes(routes: Record<string, RouteHandler>): void {
  global.fetch = jest.fn().mockImplementation((rawUrl: string) => {
    const url = new URL(rawUrl);
    for (const [pathPrefix, handler] of Object.entries(routes)) {
      if (url.pathname.startsWith(pathPrefix)) {
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

function defaultRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    '/entrez/eutils/esummary.fcgi': esummaryHandler,
    '/entrez/eutils/esearch.fcgi': () => ESEARCH_RESPONSE,
    '/entrez/eutils/efetch.fcgi': () => okText(GB_TEXT),
    '/entrez/eutils/elink.fcgi': () => ELINK_WITH_GENE,
    ...overrides,
  };
}

async function loadGenbank() {
  jest.resetModules();
  return await import('../../entities/genbank.js');
}

function callUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

function urlsContaining(fragment: string): string[] {
  return callUrls().filter(u => u.includes(fragment));
}

describe('genbankGet', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    connectionManager.closeAll();
    global.fetch = originalFetch;
  });

  test('rejects a clearly invalid accession without any HTTP call', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(genbankGet('not-an-accession')).rejects.toThrow(/Invalid GenBank accession 'not-an-accession'/);
    expect(callUrls()).toHaveLength(0);
  });

  test('esummary error envelope surfaces as Error via parseEutilsJson', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(genbankGet('NG_999999')).rejects.toThrow(/E-utilities error: Invalid uid NG_999999/);
  });

  test('happy path NG_017013.2 fetches rettype=gb retmode=text with no region', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    const record = await genbankGet('NG_017013.2');

    const efetchUrl = urlsContaining('efetch.fcgi')[0];
    expect(efetchUrl).toContain('rettype=gb');
    expect(efetchUrl).toContain('retmode=text');
    expect(efetchUrl).toContain('id=NG_017013.2');
    expect(efetchUrl).not.toContain('seq_start');
    expect(efetchUrl).not.toContain('seq_stop');
    expect(efetchUrl).not.toContain('strand');

    expect(urlsContaining('esummary.fcgi')[0]).toContain('id=NG_017013.2');
    expect(record).toEqual({
      accession: 'NG_017013.2',
      definition: 'Homo sapiens tumor protein p53 (TP53), RefSeqGene (LRG_321) on chromosome 17',
      organism: 'Homo sapiens',
      taxon_id: 9606,
      length_bp: 32772,
      topology: 'linear',
      biomol: 'genomic',
      sourcedb: 'refseq',
      format: 'genbank',
      sequence_text: GB_TEXT,
    });
    expect(record.region).toBeUndefined();
  });

  test('size gate: NC_000001.11 without a region is refused and never fetched', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(genbankGet('NC_000001.11')).rejects.toThrow(
      /NC_000001\.11 is 248956422 bp — too large to fetch whole\. Provide seq_start and seq_stop/
    );
    expect(urlsContaining('efetch.fcgi')).toHaveLength(0);
  });

  test('region 1M..1.002M on NC_000001.11 passes the gate and slices via seq_start/seq_stop', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    const record = await genbankGet('NC_000001.11', { seq_start: 1000000, seq_stop: 1002000 });

    const efetchUrl = urlsContaining('efetch.fcgi')[0];
    expect(efetchUrl).toContain('seq_start=1000000');
    expect(efetchUrl).toContain('seq_stop=1002000');
    expect(efetchUrl).toContain('rettype=gbwithparts');
    expect(record.region).toEqual({ start: 1000000, stop: 1002000, strand: 1 });
    expect(record.length_bp).toBe(248956422);
  });

  test('region larger than the 10 Mb cap is refused', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(
      genbankGet('NC_000001.11', { seq_start: 1, seq_stop: 10000001 })
    ).rejects.toThrow(/10000001 bp — exceeds the 10000000 bp maximum/);
    expect(urlsContaining('efetch.fcgi')).toHaveLength(0);
  });

  test('seq_stop beyond the record length is an error, not a clamp', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(
      genbankGet('NG_017013.2', { seq_start: 1, seq_stop: 99999999 })
    ).rejects.toThrow(/exceeds record NG_017013\.2 length 32772 bp/);
  });

  test('seq_start greater than seq_stop without strand=2 is an error', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(
      genbankGet('NC_000023.11', { seq_start: 7687550, seq_stop: 7661779 })
    ).rejects.toThrow(/only valid for a reverse-strand slice — set strand=2/);
    expect(urlsContaining('efetch.fcgi')).toHaveLength(0);
  });

  test('reverse-strand slice with strand=2 passes through to the URL', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    const record = await genbankGet('NC_000023.11', { seq_start: 7687550, seq_stop: 7661779, strand: 2 });

    const efetchUrl = urlsContaining('efetch.fcgi')[0];
    expect(efetchUrl).toContain('seq_start=7687550');
    expect(efetchUrl).toContain('seq_stop=7661779');
    expect(efetchUrl).toContain('strand=2');
    expect(efetchUrl).toContain('rettype=gbwithparts');
    expect(record.region).toEqual({ start: 7687550, stop: 7661779, strand: 2 });
  });

  test('strand without a region is an error', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(genbankGet('NG_017013.2', { strand: 2 })).rejects.toThrow(/strand requires seq_start and seq_stop/);
  });

  test('records between 2 Mb and 20 Mb use plain gb rettype when sliced', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await genbankGet('CM000663.2', { seq_start: 1, seq_stop: 2000 });

    const efetchUrl = urlsContaining('efetch.fcgi')[0];
    expect(efetchUrl).toContain('rettype=gb');
    expect(efetchUrl).not.toContain('rettype=gbwithparts');
  });

  test('format=fasta maps to rettype=fasta', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes({ '/entrez/eutils/efetch.fcgi': () => okText(FASTA_TEXT) }));

    const record = await genbankGet('NG_017013.2', { format: 'fasta' });

    const efetchUrl = urlsContaining('efetch.fcgi')[0];
    expect(efetchUrl).toContain('rettype=fasta');
    expect(efetchUrl).toContain('retmode=text');
    expect(record.format).toBe('fasta');
    expect(record.sequence_text).toBe(FASTA_TEXT);
  });

  test('efetch inline error text is converted to an Error', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes({
      '/entrez/eutils/efetch.fcgi': () => okText('Error: Failed to understand Id'),
    }));

    await expect(genbankGet('NG_017013.2')).rejects.toThrow(/efetch for 'NG_017013\.2': E-utilities error: Error: Failed to understand Id/);
  });

  test('response larger than maxResponseBytes is refused', async () => {
    const { genbankGet } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await expect(
      genbankGet('NG_017013.2', { maxResponseBytes: 50 })
    ).rejects.toThrow(/exceeds maxResponseBytes \(50\)/);
  });
});

describe('genbankSearch', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    connectionManager.closeAll();
    global.fetch = originalFetch;
  });

  test('composes the term with organism and queries nuccore esearch', async () => {
    const { genbankSearch } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await genbankSearch('TP53[Gene Name]', { organism: 'Homo sapiens' });

    const searchUrl = new URL(urlsContaining('esearch.fcgi')[0]);
    expect(searchUrl.searchParams.get('db')).toBe('nuccore');
    expect(searchUrl.searchParams.get('retmode')).toBe('json');
    expect(searchUrl.searchParams.get('term')).toBe('TP53[Gene Name] AND Homo sapiens[Organism]');
  });

  test('retmax is capped at 50', async () => {
    const { genbankSearch } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    await genbankSearch('TP53[Gene Name]', { limit: 100 });

    const searchUrl = new URL(urlsContaining('esearch.fcgi')[0]);
    expect(searchUrl.searchParams.get('retmax')).toBe('50');
  });

  test('results keep esearch order and map esummary fields including chromosome', async () => {
    const { genbankSearch } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    const results = await genbankSearch('TP53[Gene Name] AND Homo sapiens[Organism]');

    const summaryUrl = new URL(urlsContaining('esummary.fcgi')[0]);
    expect(summaryUrl.searchParams.get('id')).toBe('200,100');

    expect(results.map(r => r.accession)).toEqual(['U12345.1', 'NG_017013.2']);
    expect(results[0]).toMatchObject({
      definition: 'Human mRNA clone',
      length_bp: 1500,
      organism: 'Homo sapiens',
      taxon_id: 9606,
      biomol: 'mRNA',
      topology: 'linear',
      sourcedb: 'insd',
      chromosome: '',
      updated: '1994/03/01',
    });
    expect(results[1]).toMatchObject({
      definition: 'TP53 RefSeqGene',
      length_bp: 32772,
      sourcedb: 'refseq',
      chromosome: '17',
    });
  });

  test('empty esearch idlist short-circuits to [] without esummary', async () => {
    const { genbankSearch } = await loadGenbank();
    mockFetchRoutes(defaultRoutes({
      '/entrez/eutils/esearch.fcgi': () => ({ esearchresult: { count: '0', idlist: [] } }),
    }));

    await expect(genbankSearch('ZZZNOTHING')).resolves.toEqual([]);
    expect(urlsContaining('esummary.fcgi')).toHaveLength(0);
  });
});

describe('genbankToGeneIds', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    connectionManager.closeAll();
    global.fetch = originalFetch;
  });

  test('parses elink gene ids as numbers', async () => {
    const { genbankToGeneIds } = await loadGenbank();
    mockFetchRoutes(defaultRoutes());

    const geneIds = await genbankToGeneIds('NG_017013.2');

    const elinkUrl = new URL(urlsContaining('elink.fcgi')[0]);
    expect(elinkUrl.searchParams.get('dbfrom')).toBe('nuccore');
    expect(elinkUrl.searchParams.get('db')).toBe('gene');
    expect(elinkUrl.searchParams.get('id')).toBe('383209646');
    expect(geneIds).toEqual([7157]);
  });

  test('missing gene links is a legitimate empty result', async () => {
    const { genbankToGeneIds } = await loadGenbank();
    mockFetchRoutes(defaultRoutes({ '/entrez/eutils/elink.fcgi': () => ELINK_EMPTY }));

    await expect(genbankToGeneIds('NG_017013.2')).resolves.toEqual([]);
  });

  test('gene ids are capped at 100', async () => {
    const { genbankToGeneIds } = await loadGenbank();
    const links = Array.from({ length: 150 }, (_, i) => String(i + 1));
    mockFetchRoutes(defaultRoutes({
      '/entrez/eutils/elink.fcgi': () => ({
        linksets: [{ dbfrom: 'nuccore', ids: ['383209646'], linksetdbs: [{ dbto: 'gene', links }] }],
      }),
    }));

    const geneIds = await genbankToGeneIds('NG_017013.2');

    expect(geneIds).toHaveLength(100);
    expect(geneIds[0]).toBe(1);
    expect(geneIds[99]).toBe(100);
  });
});

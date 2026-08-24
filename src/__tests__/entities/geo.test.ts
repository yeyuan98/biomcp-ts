import { jest } from '@jest/globals';
import { connectionManager } from '../../connections/manager.js';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const GEO_ACC = 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi';

const LONG_SUMMARY = 'x'.repeat(600);

const GSE_SOFT_FULL = [
  '^SERIES = GSE183947',
  '!Series_title = Identification of five cytotoxicity-related genes',
  '!Series_geo_accession = GSE183947',
  '!Series_status = Public on Sep 15 2021',
  '!Series_pubmed_id = 35046993',
  '!Series_type = Expression profiling by high throughput sequencing',
  '!Series_overall_design = RNA-seq of tumor and normal samples',
  `!Series_summary = ${LONG_SUMMARY}`,
  '!Series_platform_id = GPL11154',
  '!Series_contributor = Yan,,Zhang',
  '!Series_contributor = Alice,B,Smith',
  '!Series_sample_id = GSM5574685',
  '!Series_sample_id = GSM5574686',
  '!Series_supplementary_file = ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE183nnn/GSE183947/suppl/GSE183947_fpkm.csv.gz',
  '!Series_relation = BioProject: https://www.ncbi.nlm.nih.gov/bioproject/PRJNA762469',
  '!Series_relation = SRA: https://www.ncbi.nlm.nih.gov/sra?term=SRP336638',
  '!Series_relation = SuperSeries of GSE12345',
  '!Series_relation = SubSeries of GSE99999',
  '',
].join('\r\n');

const GSE_SOFT_NO_SRA = GSE_SOFT_FULL
  .replace(/^!Series_relation = SRA:.*\r?\n/m, '')
  .replace(/^!Series_relation = BioProject:.*\r?\n/m, '');

const GSE_SOFT_NO_SUPP = GSE_SOFT_FULL
  .replace(/^!Series_supplementary_file = .*\r?\n/m, '');

const GSM_SOFT_FULL = [
  '^SAMPLE = GSM5574685',
  '!Sample_title = tumor rep1',
  '!Sample_geo_accession = GSM5574685',
  '!Sample_status = Public on Sep 15 2021',
  '!Sample_source_name_ch1 = tumor tissue',
  '!Sample_organism_ch1 = Homo sapiens',
  '!Sample_taxid_ch1 = 9606',
  '!Sample_characteristics_ch1 = tissue: tumor',
  '!Sample_characteristics_ch1 = replicate: 1',
  '!Sample_platform_id = GPL11154',
  '!Sample_series_id = GSE183947',
  '!Sample_relation = SRA: https://www.ncbi.nlm.nih.gov/sra?term=SRX15578991',
  '!Sample_supplementary_file = ftp://ftp.ncbi.nlm.nih.gov/geo/samples/GSM5574nnn/GSM5574685/suppl/GSM5574685_tumor.counts.csv.gz',
  '',
].join('\n');

// 25 embedded samples — geoGet must preview only the first 20 while keeping
// the true total from n_samples.
const ESUMMARY_SAMPLES = Array.from({ length: 25 }, (_, i) => ({
  accession: `GSM${5574685 + i}`,
  title: `tumor rep${i}`,
}));

const GDS_UIDS: Record<string, string> = {
  GSE183947: '200183947',
  GSE999001: '200999001',
  GSM5574685: '2005574685',
};

function gseEntry(): Record<string, unknown> {
  return {
    uid: '200183947',
    accession: 'GSE183947',
    title: 'Identification of five cytotoxicity-related genes',
    summary: LONG_SUMMARY,
    gpl: '11154',
    gse: '183947',
    taxon: 'Homo sapiens',
    entrytype: 'GSE',
    gdstype: 'Expression profiling by high throughput sequencing',
    pdat: '2021/09/15',
    suppfile: 'CSV',
    n_samples: 60,
    samples: ESUMMARY_SAMPLES,
    pubmedids: [35046993],
    bioproject: 'PRJNA762469',
    extrelations: [{ relationtype: 'SRA', targetobject: 'SRP336638' }],
  };
}

function esummaryEntries(): Record<string, () => Record<string, unknown>> {
  return {
    '200183947': gseEntry,
    '200999001': () => ({ ...gseEntry(), uid: '200999001', accession: 'GSE999001' }),
    '200254917': () => ({
      uid: '200254917',
      accession: 'GSE254917',
      title: 'Unrelated melanoma series',
      entrytype: 'GSE',
      taxon: 'Homo sapiens',
      pdat: '2019/01/01',
      n_samples: 3,
    }),
    '2005574685': () => ({
      uid: '2005574685',
      accession: 'GSM5574685',
      title: 'tumor rep1',
      entrytype: 'GSM',
      taxon: 'Homo sapiens',
      n_samples: 1,
    }),
  };
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
}

function okText(text: string, contentType = 'text/plain') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve(text),
    headers: new Headers({ 'content-type': contentType }),
  };
}

function okBinary(content: Buffer, contentLength?: number) {
  const arrayBuffer = new ArrayBuffer(content.length);
  new Uint8Array(arrayBuffer).set(content);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: () => Promise.resolve(arrayBuffer),
    headers: new Headers({ 'content-length': String(contentLength ?? content.length) }),
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

interface EutilsOverrides {
  esearch?: RouteHandler;
  esummary?: RouteHandler;
  elink?: RouteHandler;
  extrelations?: Array<Record<string, unknown>>;
}

function defaultRoutes(overrides: EutilsOverrides = {}): Record<string, RouteHandler> {
  return {
    [`${EUTILS}/esearch.fcgi`]: overrides.esearch ?? ((url) => {
      const term = url.searchParams.get('term') ?? '';
      const accession = /^\w+\d+\[Accession\]$/.exec(term)?.[0]?.replace('[Accession]', '');
      if (accession && GDS_UIDS[accession]) {
        return { esearchresult: { count: '1', idlist: [GDS_UIDS[accession]] } };
      }
      return { esearchresult: { count: '2', retmax: '2', idlist: ['200183947', '200254917'] } };
    }),
    [`${EUTILS}/esummary.fcgi`]: overrides.esummary ?? ((url) => {
      const entries = esummaryEntries();
      if (overrides.extrelations !== undefined) {
        for (const key of Object.keys(entries)) {
          const base = entries[key];
          entries[key] = () => ({ ...base(), extrelations: overrides.extrelations });
        }
      }
      const ids = (url.searchParams.get('id') ?? '').split(',');
      const result: Record<string, unknown> = { uids: [...ids].reverse() };
      for (const id of ids) {
        const factory = entries[id];
        if (factory) result[id] = factory();
      }
      return { result };
    }),
    [`${EUTILS}/elink.fcgi`]: overrides.elink ?? (() => ({
      linksets: [{
        dbfrom: 'gds',
        ids: ['200183947'],
        linksetdbs: [{ dbto: 'sra', linkname: 'gds_sra', links: ['8877661', '8877662'] }],
      }],
    })),
    [GEO_ACC]: (url) => {
      const acc = (url.searchParams.get('acc') ?? '').toUpperCase();
      if (acc === 'GSM5574685') return okText(GSM_SOFT_FULL);
      if (acc === 'GSE999001') return okText(GSE_SOFT_NO_SRA);
      return okText(GSE_SOFT_FULL);
    },
  };
}

async function loadGeo() {
  jest.resetModules();
  return await import('../../entities/geo.js');
}

function callUrls(): string[] {
  return (global.fetch as any).mock.calls.map((c: any[]) => c[0] as string);
}

function eutilsUrls(): string[] {
  return callUrls().filter(u => u.includes('eutils'));
}

describe('geoSearch', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('composes ETYP and ORGN term filters with capped retmax', async () => {
    const { geoSearch } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    await geoSearch('cytotoxicity', { entryType: 'gse', organism: 'Homo sapiens', limit: 5 });

    const searchUrl = eutilsUrls().find(u => u.includes('esearch'))!;
    const parsed = new URL(searchUrl);
    expect(parsed.searchParams.get('db')).toBe('gds');
    expect(parsed.searchParams.get('term')).toBe('cytotoxicity AND gse[ETYP] AND Homo sapiens[ORGN]');
    expect(parsed.searchParams.get('retmax')).toBe('5');
    expect(parsed.searchParams.get('retstart')).toBe('0');
    expect(parsed.searchParams.get('retmode')).toBe('json');
  });

  test('retmax is capped at 50', async () => {
    const { geoSearch } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    await geoSearch('cancer', { limit: 100 });

    const searchUrl = eutilsUrls().find(u => u.includes('esearch'))!;
    expect(new URL(searchUrl).searchParams.get('retmax')).toBe('50');
  });

  test('maps esummary entries in esearch idlist order and never embeds samples', async () => {
    const { geoSearch } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    const results = await geoSearch('cytotoxicity');

    expect(results.map(r => r.accession)).toEqual(['GSE183947', 'GSE254917']);
    expect(results[0]).toMatchObject({
      uid: '200183947',
      entry_type: 'GSE',
      organism: 'Homo sapiens',
      gds_type: 'Expression profiling by high throughput sequencing',
      platform: 'GPL11154',
      publication_date: '2021/09/15',
      n_samples: 60,
      pubmed_ids: [35046993],
      bioproject: 'PRJNA762469',
      sra_project: 'SRP336638',
      supplementary_file_format: 'CSV',
    });
    for (const item of results) {
      expect(item).not.toHaveProperty('samples');
    }
  });

  test('truncates long summaries to ~500 chars', async () => {
    const { geoSearch } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    const [first] = await geoSearch('cytotoxicity');

    expect(first!.summary!.length).toBe(500);
    expect(first!.summary!.endsWith('...')).toBe(true);
  });

  test('eutils error envelope (HTTP 200 esearchresult.error) surfaces', async () => {
    const { geoSearch } = await loadGeo();
    mockFetchRoutes(defaultRoutes({
      esearch: () => ({ esearchresult: { error: 'Query disabled' } }),
    }));

    await expect(geoSearch('cytotoxicity')).rejects.toThrow('GEO dataset search: E-utilities error: Query disabled');
  });

  test('empty idlist returns [] without calling esummary', async () => {
    const { geoSearch } = await loadGeo();
    mockFetchRoutes(defaultRoutes({
      esearch: () => ({ esearchresult: { count: '0', idlist: [] } }),
    }));

    await expect(geoSearch('nothing')).resolves.toEqual([]);
    expect(eutilsUrls().filter(u => u.includes('esummary')).length).toBe(0);
  });
});

describe('geoGet validation', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('GDS accessions are rejected with a helpful error', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    await expect(geoGet('GDS5132')).rejects.toThrow(
      /curated GEO DataSet records.*GSE/s
    );
  });

  test('malformed accessions are rejected', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    await expect(geoGet('not-an-accession')).rejects.toThrow('Invalid GEO accession');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('geoGet series detail', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('merges SOFT detail with esummary enrichment (samples capped at 20)', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    const detail = await geoGet('GSE183947');

    if (detail.entry_type !== 'series') throw new Error('expected series detail');
    expect(detail.title).toBe('Identification of five cytotoxicity-related genes');
    expect(detail.status).toBe('Public on Sep 15 2021');
    expect(detail.type).toBe('Expression profiling by high throughput sequencing');
    expect(detail.overall_design).toBe('RNA-seq of tumor and normal samples');
    expect(detail.publication_date).toBe('2021/09/15');
    expect(detail.organisms).toContain('Homo sapiens');
    expect(detail.contributor_names).toEqual(['Yan Zhang', 'Alice Smith']);
    expect(detail.platform_ids).toEqual(['GPL11154']);
    expect(detail.supplementary_files).toEqual([
      'ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE183nnn/GSE183947/suppl/GSE183947_fpkm.csv.gz',
    ]);
    expect(detail.samples).toHaveLength(20);
    expect(detail.samples[0]).toEqual({ accession: 'GSM5574685', title: 'tumor rep0' });
    expect(detail.samples[19]).toEqual({ accession: 'GSM5574704', title: 'tumor rep19' });
    expect(detail.n_samples).toBe(60);
    expect(detail.pubmed_ids).toEqual([35046993]);
    expect(detail.bioproject).toBe('PRJNA762469');
    expect(detail.sra).toEqual(['SRP336638']);
    expect(detail.super_series).toEqual(['GSE12345']);
    expect(detail.sub_series).toEqual(['GSE99999']);
    expect(detail.relations_raw).toHaveLength(4);
    expect(detail).not.toHaveProperty('download');
  });

  test('falls back to SOFT sample ids and status date when enrichment is unavailable', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes(defaultRoutes({
      esearch: () => ({ esearchresult: { count: '0', idlist: [] } }),
    }));

    const detail = await geoGet('GSE183947');

    if (detail.entry_type !== 'series') throw new Error('expected series detail');
    expect(detail.samples).toEqual([
      { accession: 'GSM5574685', title: undefined },
      { accession: 'GSM5574686', title: undefined },
    ]);
    expect(detail.n_samples).toBe(2);
    expect(detail.publication_date).toBe('2021-09-15');
  });

  test('HTML block page from geo_soft is detected and reported', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes({
      [GEO_ACC]: () => okText('<html><body>Access Denied</body></html>', 'text/html'),
    });

    await expect(geoGet('GSE183947')).rejects.toThrow(/HTML page.*blocked/s);
  });
});

describe('geoGet sample detail', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('maps sample-shaped SOFT fields', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    const detail = await geoGet('GSM5574685');

    if (detail.entry_type !== 'sample') throw new Error('expected sample detail');
    expect(detail.title).toBe('tumor rep1');
    expect(detail.status).toBe('Public on Sep 15 2021');
    expect(detail.source_name).toBe('tumor tissue');
    expect(detail.organism).toBe('Homo sapiens');
    expect(detail.characteristics).toEqual(['tissue: tumor', 'replicate: 1']);
    expect(detail.platform_id).toBe('GPL11154');
    expect(detail.series).toBe('GSE183947');
    expect(detail.sra).toEqual(['SRX15578991']);
    expect(detail.supplementary_files[0]).toContain('GSM5574685_tumor.counts.csv.gz');
  });
});

describe('geoGet supplementary download', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('downloads the .gz file verbatim over https into a temp dir', async () => {
    const { geoGet } = await loadGeo();
    const payload = Buffer.from('GEO supplementary payload');
    mockFetchRoutes({
      ...defaultRoutes(),
      'https://ftp.ncbi.nlm.nih.gov/': () => okBinary(payload),
    });

    const detail = await geoGet('GSE183947', { download: true });

    if (detail.entry_type !== 'series') throw new Error('expected series detail');
    const download = detail.download!;
    expect(download.filename).toBe('GSE183947_fpkm.csv.gz');
    expect(download.url).toBe(
      'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE183nnn/GSE183947/suppl/GSE183947_fpkm.csv.gz'
    );
    expect(callUrls()).toContain(download.url);
    expect(download.size_bytes).toBe(payload.length);
    expect(download.path).toContain(`${tmpdir()}/geo_`);
    expect(existsSync(download.path)).toBe(true);
    // .gz written VERBATIM (binary, no text decode / gunzip)
    expect(readFileSync(download.path).equals(payload)).toBe(true);
  });

  test('pre-flight Content-Length above the cap is rejected before download', async () => {
    const { geoGet } = await loadGeo();
    const huge = Buffer.from('x');
    mockFetchRoutes({
      ...defaultRoutes(),
      'https://ftp.ncbi.nlm.nih.gov/': () => okBinary(huge, 60 * 1024 * 1024),
    });

    await expect(geoGet('GSE183947', { download: true })).rejects.toThrow(/exceeding the \d+ byte cap/);
  });

  test('post-download size check also enforces the cap', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes({
      ...defaultRoutes(),
      // Content-Length missing — only the post-read guard can catch the size.
      'https://ftp.ncbi.nlm.nih.gov/': () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2 * 1024 * 1024)),
        headers: new Headers(),
      }),
    });

    await expect(geoGet('GSE183947', { download: true, maxBytes: 1024 * 1024 })).rejects.toThrow(/exceeding/);
  });

  test('no supplementary file → clear error, list never fabricated', async () => {
    const { geoGet } = await loadGeo();
    mockFetchRoutes({
      ...defaultRoutes(),
      [GEO_ACC]: () => okText(GSE_SOFT_NO_SUPP),
    });

    await expect(geoGet('GSE183947', { download: true })).rejects.toThrow(
      'No supplementary file available for GSE183947'
    );
  });
});

describe('geoToSraAccessions', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('SOFT relations take priority — no eutils calls when SRP is embedded', async () => {
    const { geoToSraAccessions } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    await expect(geoToSraAccessions('GSE183947')).resolves.toEqual(['SRP336638']);
    expect(eutilsUrls()).toHaveLength(0);
  });

  test('esummary extrelations are used when SOFT has no SRA relation', async () => {
    const { geoToSraAccessions } = await loadGeo();
    mockFetchRoutes(defaultRoutes());

    await expect(geoToSraAccessions('GSE999001')).resolves.toEqual(['SRP336638']);

    const urls = eutilsUrls();
    expect(urls.some(u => u.includes('esearch'))).toBe(true);
    expect(urls.some(u => u.includes('esummary'))).toBe(true);
    expect(urls.some(u => u.includes('elink'))).toBe(false);
  });

  test('elink fallback returns [] — run-level UIDs are never surfaced as accessions', async () => {
    const { geoToSraAccessions } = await loadGeo();
    mockFetchRoutes(defaultRoutes({
      extrelations: [],
    }));

    await expect(geoToSraAccessions('GSE999001')).resolves.toEqual([]);
    const elink = eutilsUrls().find(u => u.includes('elink'));
    expect(elink).toBeDefined();
    expect(new URL(elink!).searchParams.get('dbfrom')).toBe('gds');
    expect(new URL(elink!).searchParams.get('db')).toBe('sra');
  });
});

import { jest } from '@jest/globals';

const PPUBS_TEMPLATE_SENTINEL = 'showDocPerFamilyPref';

describe('patent search transforms', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.EPO_OPS_CONSUMER_KEY;
    delete process.env.EPO_OPS_CONSUMER_SECRET;
    delete process.env.USPTO_API_KEY;
  });

  test('transformGooglePatentsResult strips HTML and maps fields', async () => {
    const { transformGooglePatentsResult } = await import('../../entities/patent/search/google-patents.js');
    const result = transformGooglePatentsResult({
      title: ' <b>CRISPR</b>-Cas systems &hellip;',
      snippet: 'An isolated <b>eukaryotic</b> host cell&hellip;',
      publication_number: 'US11027025B2',
      publication_date: '2021-06-08',
      filing_date: '2014-07-11',
      priority_date: '2013-07-11',
      inventor: ['Hoge, Stephen'],
      assignee: ['ModernaTx Inc'],
      language: 'en',
    });
    expect(result.title).toBe('CRISPR-Cas systems …');
    expect(result.snippet).toContain('eukaryotic host cell…');
    expect(result.publication_number).toBe('US11027025B2');
    expect(result.status).toBe('granted');
    expect(result.source).toBe('google_patents');
    expect(result.inventor).toEqual(['Hoge, Stephen']);
  });

  test('transformGooglePatentsResult marks A-kind as application', async () => {
    const { transformGooglePatentsResult } = await import('../../entities/patent/search/google-patents.js');
    const result = transformGooglePatentsResult({ publication_number: 'US20230287058A1' });
    expect(result.status).toBe('application');
  });

  test('transformPpubsResult maps type, kind, and applicant fallback', async () => {
    const { transformPpubsResult } = await import('../../entities/patent/search/ppubs.js');
    const grant = transformPpubsResult({
      guid: 'US-11027025-B2',
      publicationReferenceDocumentNumber: '11027025',
      inventionTitle: 'Compositions comprising synthetic polynucleotides',
      datePublished: '2021-06-08T00:00:00Z',
      type: 'USPAT',
      applicantName: ['ModernaTx, Inc.'],
      assigneeName: null,
      applicationFilingDate: ['2014-07-11T00:00:00Z'],
      cpcInventiveFlattened: 'A61K9/51;A61K31/7105',
    });
    expect(grant.publication_number).toBe('US11027025B2');
    expect(grant.status).toBe('granted');
    expect(grant.assignee).toEqual(['ModernaTx, Inc.']);
    expect(grant.cpc_codes).toEqual(['A61K9/51', 'A61K31/7105']);
    expect(grant.publication_date).toBe('2021-06-08');

    const app = transformPpubsResult({
      guid: 'US-20260240819-A1',
      publicationReferenceDocumentNumber: '20260240819',
      type: 'US-PGPUB',
      applicantName: ['Pfizer Inc.'],
    });
    expect(app.publication_number).toBe('US20260240819A1');
    expect(app.status).toBe('application');
  });

  test('transformOpsSearchHit parses BadgerFish biblio', async () => {
    const { transformOpsSearchHit } = await import('../../entities/patent/search/ops.js');
    const hit = transformOpsSearchHit({
      '@country': 'US',
      '@doc-number': '11027025',
      '@kind': 'B2',
      '@family-id': '52280736',
      'bibliographic-data': {
        'invention-title': [
          { '$': 'COMPOSITIONS COMPRENANT DES POLYNUCLEOTIDES', '@lang': 'fr' },
          { '$: ': 'x', '$': 'Compositions comprising synthetic polynucleotides', '@lang': 'en' },
        ],
        'parties': {
          'applicants': { 'applicant': [{ 'applicant-name': { 'name': { '$': 'MODERNATHERAPEUTICS [US]' } } }] },
          'inventors': { 'inventor': [{ 'inventor-name': { 'name': { '$': 'HOGE STEPHEN G [US]' } } }] },
        },
        'publication-reference': {
          'document-id': [
            { '@document-id-type': 'docdb', 'country': { '$': 'US' }, 'doc-number': { '$': '11027025' }, 'kind': { '$': 'B2' }, 'date': { '$': '20210608' } },
          ],
        },
        'application-reference': {
          'document-id': [{ '@document-id-type': 'epodoc', 'doc-number': { '$': 'US201414912345' }, 'date': { '$': '20140711' } }],
        },
        'patent-classifications': {
          'patent-classification': [
            { 'section': { '$': 'C' }, 'class': { '$': '12' }, 'subclass': { '$': 'N' }, 'main-group': { '$': '15' }, 'subgroup': { '$': '111' }, 'classification-value': { '$': 'I' } },
          ],
        },
      },
    });
    expect(hit.publication_number).toBe('US11027025B2');
    expect(hit.title).toBe('Compositions comprising synthetic polynucleotides');
    expect(hit.publication_date).toBe('2021-06-08');
    expect(hit.filing_date).toBe('2014-07-11');
    expect(hit.assignee).toEqual(['MODERNATHERAPEUTICS [US]']);
    expect(hit.cpc_codes).toEqual(['C12N15/111']);
    expect(hit.status).toBe('granted');
  });

  test('transformOdpWrapper maps granted vs pending', async () => {
    const { transformOdpWrapper } = await import('../../entities/patent/search/odp.js');
    const granted = transformOdpWrapper({
      applicationNumberText: '14912345',
      applicationMetaData: {
        inventionTitle: 'Compositions',
        patentNumber: '11027025',
        grantDate: '2021-06-08',
        filingDate: '2014-07-11',
        firstApplicantName: 'ModernaTx, Inc.',
        firstInventorName: 'Hoge, Stephen G.',
      },
    });
    expect(granted.publication_number).toBe('US11027025');
    expect(granted.status).toBe('granted');

    const pending = transformOdpWrapper({
      applicationMetaData: { inventionTitle: 'Pending', patentNumber: null },
    });
    expect(pending.status).toBe('application');
  });
});

describe('patent dedup and normalization', () => {
  test('normalizePublicationNumber and isValidPublicationNumber', async () => {
    const { normalizePublicationNumber, isValidPublicationNumber } = await import('../../entities/patent/search/dedup.js');
    expect(normalizePublicationNumber('us 11027025 b2')).toBe('US11027025B2');
    expect(isValidPublicationNumber('US11027025B2')).toBe(true);
    expect(isValidPublicationNumber('US11027025')).toBe(true);
    expect(isValidPublicationNumber('US20260240819A1')).toBe(true);
    expect(isValidPublicationNumber('EP3904939B1')).toBe(true);
    expect(isValidPublicationNumber('USRE48517E1')).toBe(true);
    expect(isValidPublicationNumber('WO2015006747A2')).toBe(true);
    expect(isValidPublicationNumber('crispr')).toBe(false);
    expect(isValidPublicationNumber('12345')).toBe(false);
  });

  test('dedupPatents merges US overlap preferring official sources and stripping kind codes', async () => {
    const { dedupPatents } = await import('../../entities/patent/search/dedup.js');
    const merged = dedupPatents([
      { publication_number: 'US11027025B2', title: 'From PPUBS', source: 'ppubs' },
      { publication_number: 'US11027025', title: 'From ODP', snippet: 'extra', source: 'uspto_odp' },
      { publication_number: 'EP3904939B1', title: 'EP patent', source: 'ops' },
    ]);
    expect(merged).toHaveLength(2);
    const us = merged.find(p => p.publication_number.startsWith('US11027025'));
    expect(us?.source).toBe('uspto_odp');
    expect(us?.title).toBe('From ODP');
    expect(us?.also_found_in).toEqual(['ppubs']);
  });
});

describe('patent search federation', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.EPO_OPS_CONSUMER_KEY;
    delete process.env.EPO_OPS_CONSUMER_SECRET;
    delete process.env.USPTO_API_KEY;
  });

  test('selectSearchBackends: keyed sources preferred, GP omitted when OPS present', async () => {
    const { selectSearchBackends } = await import('../../entities/patent/search/index.js');
    expect(selectSearchBackends({})).toEqual(['google_patents', 'ppubs']);
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    process.env.USPTO_API_KEY = 'u';
    expect(selectSearchBackends({})).toEqual(['ops', 'uspto_odp']);
    expect(selectSearchBackends({ source: 'ppubs' })).toEqual(['ppubs']);
  });

  test('patentSearch appends _error element when a backend fails', async () => {
    process.env.USPTO_API_KEY = 'u';
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('api.uspto.gov')) {
        const payload = JSON.stringify({
          count: 1,
          patentFileWrapperDataBag: [{
            applicationNumberText: '14912345',
            applicationMetaData: {
              inventionTitle: 'Crispr compositions',
              patentNumber: '11027025',
              grantDate: '2021-06-08',
            },
          }],
        });
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(payload),
          json: () => Promise.resolve(JSON.parse(payload)),
        });
      }
      // google_patents live fetch (worldwide fallback without OPS creds)
      return Promise.reject(new Error('HTTP 503: Service Unavailable'));
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await patentSearch('crispr compositions', {});
    expect(response.patents.some(p => (p as any)._error)).toBe(true);
    expect(response.patents.some(p => p.publication_number === 'US11027025')).toBe(true);
  });

  test('google patents breaker opens on 503 and short-circuits subsequent calls', async () => {
    const gp = await import('../../entities/patent/search/google-patents.js');
    gp.resetGooglePatentsBreaker();
    expect(gp.isGooglePatentsBlocked()).toBe(false);

    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers(),
      text: () => Promise.resolve('Sorry... automated queries'),
    }) as any;

    await expect(gp.searchGooglePatents('crispr', {})).rejects.toThrow();
    expect(gp.isGooglePatentsBlocked()).toBe(true);
    await expect(gp.searchGooglePatents('crispr', {})).rejects.toThrow(/temporarily unavailable/);
    // Second call must not hit fetch again (short-circuit)
    expect(global.fetch).toHaveBeenCalledTimes(1);
    gp.resetGooglePatentsBreaker();
    connectionManager.closeAll();
  });

  test('google patents search quotes multi-word phrases (OR-junk guard)', async () => {
    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ results: { cluster: [{ result: [{ patent: { publication_number: 'US1B2', title: 'X' } }] }] } }),
    }) as any;

    const { searchGooglePatents } = await import('../../entities/patent/search/google-patents.js');
    await searchGooglePatents('crispr cas9', {});
    const calledUrl = String((global.fetch as any).mock.calls[0][0]);
    const innerParam = new URL(calledUrl).searchParams.get('url') || '';
    // Inner param is form-encoded: %22 → quote, + → space
    const inner = innerParam.replace(/\+/g, ' ').replace(/%22/g, '"');
    expect(inner).toContain('q="crispr cas9"');
    connectionManager.closeAll();
  });
});

describe('OpsClient', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.EPO_OPS_CONSUMER_KEY = 'test-key';
    process.env.EPO_OPS_CONSUMER_SECRET = 'test-secret';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.EPO_OPS_CONSUMER_KEY;
    delete process.env.EPO_OPS_CONSUMER_SECRET;
  });

  test('token fetch: single-flight under concurrency, cached until expiry', async () => {
    const { OpsClient } = await import('../../entities/patent/ops-client.js');
    const client = new OpsClient();
    let tokenCalls = 0;
    global.fetch = jest.fn().mockImplementation((url: any) => {
      if (String(url).includes('/auth/accesstoken')) {
        tokenCalls++;
        const payload = JSON.stringify({ access_token: `tok-${tokenCalls}`, expires_in: 1199 });
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(payload),
          json: () => Promise.resolve({ access_token: `tok-${tokenCalls}`, expires_in: 1199 }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('{}'),
      });
    }) as any;

    const [a, b] = await Promise.all([client.getToken(), client.getToken()]);
    expect(a).toBe(b);
    expect(tokenCalls).toBe(1);
    const c = await client.getToken();
    expect(c).toBe('tok-1');
    expect(tokenCalls).toBe(1);
    client.close();
  });

  test('get() retries once on 403 quota rejection and surfaces final status', async () => {
    const { OpsClient } = await import('../../entities/patent/ops-client.js');
    const client = new OpsClient();
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ access_token: 'tok', expires_in: 1199 })),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'x-rejection-reason': 'IndividualQuotaPerHour' }),
        text: () => Promise.resolve('violation of Fair Use policy'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('{"ok":true}'),
      }) as any;

    const resp = await client.get('/published-data/search?q=x');
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('{"ok":true}');
    client.close();
  });

  test('get() throws descriptive error on bad credentials', async () => {
    const { OpsClient } = await import('../../entities/patent/ops-client.js');
    const client = new OpsClient();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: () => Promise.resolve('ClientId is Invalid'),
    }) as any;
    await expect(client.getToken()).rejects.toThrow(/EPO_OPS_CONSUMER_KEY/);
    client.close();
  });
});

describe('PpubsClient', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockSession() {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'x-access-token': 'tok-1', 'content-type': 'application/json' }),
      text: () => Promise.resolve(JSON.stringify({ userCase: { caseId: 12345 } })),
    };
  }

  test('session handshake single-flight; search uses exact template keys', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    let sessionCalls = 0;
    let searchBodies: Array<Record<string, unknown>> = [];

    global.fetch = jest.fn().mockImplementation((url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/users/me/session')) {
        sessionCalls++;
        return Promise.resolve(mockSession());
      }
      if (u.includes('/api/searches/searchWithBeFamily')) {
        searchBodies.push(JSON.parse(init.body));
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ patents: [{ guid: 'US-11027025-B2' }] })),
        });
      }
      return Promise.reject(new Error(`unexpected url: ${u}`));
    }) as any;

    await client.search('crispr', { pageCount: 5 });
    await client.search('crispr AND (moderna).as.', { pageCount: 5 });

    expect(sessionCalls).toBe(1); // cached session
    expect(searchBodies).toHaveLength(2);
    // Exact template keys (showDocPerFamilyPref — one wrong key 500s upstream)
    expect(searchBodies[0][PPUBS_TEMPLATE_SENTINEL]).toBe('showEnglish');
    expect(searchBodies[0]['showDocFamilyPref']).toBeUndefined();
    expect((searchBodies[0].query as any).caseId).toBe(12345);
    expect((searchBodies[0].query as any).op).toBe('AND');
    const filters = (searchBodies[0].query as any).databaseFilters as Array<{ databaseName: string }>;
    expect(filters.map(f => f.databaseName)).toEqual(['US-PGPUB', 'USPAT', 'USOCR']);
    client.close();
  });

  test('search refreshes session on 401 and retries once', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    let call = 0;
    global.fetch = jest.fn().mockImplementation((url: any) => {
      call++;
      const u = String(url);
      if (u.includes('/api/users/me/session')) {
        return Promise.resolve(mockSession());
      }
      // first search → 401; second (after refresh) → 200
      if (u.includes('/api/searches/searchWithBeFamily') && call === 2) {
        return Promise.resolve({
          ok: false,
          status: 401,
          headers: new Headers(),
          text: () => Promise.resolve('unauthorized'),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ patents: [] })),
      });
    }) as any;

    const resp = await client.search('crispr', {});
    expect(resp.status).toBe(200);
    client.close();
  });
});

describe('parseGooglePatentHtml', () => {
  test('parses US-style page with claims, citations, family, classifications', async () => {
    const { parseGooglePatentHtml } = await import('../../entities/patent/detail/parse.js');
    const html = `
      <html><head>
      <meta name="DC.type" content="patent">
      <meta name="DC.title" content="Compositions comprising synthetic polynucleotides">
      <meta name="DC.date" content="2014-07-11" scheme="dateSubmitted">
      <meta name="DC.date" content="2021-06-08" scheme="issue">
      <meta name="DC.contributor" content="Stephen G. Hoge" scheme="inventor">
      <meta name="DC.contributor" content="ModernaTx Inc" scheme="assignee">
      </head><body>
      <span itemprop="publicationNumber">US11027025B2</span>
      <time itemprop="publicationDate">2021-06-08</time>
      <time itemprop="priorityDate">2013-07-11</time>
      <td itemprop="status">Active</td>
      <div class="abstract">The present invention relates to compositions comprising &hellip; modified mRNA.</div>
      <section itemprop="claims" itemscope>
        <h2>Claims (<span itemprop="count">2</span>)</h2>
        <div itemprop="content" html><div class="claims">
          <div id="CLM-00001" num="00001" class="claim"><div class="claim-text">1. A composition comprising lipid nanoparticles.</div></div>
          <div id="CLM-00002" num="00002" class="claim"><div class="claim-text">2. The composition of claim 1.</div></div>
        </div></div>
      </section>
      <tr itemprop="backwardReferences" itemscope repeat>
        <td><span itemprop="publicationNumber">US5034506</span></td>
        <td itemprop="title">Nucleotide delivery</td>
        <td><time itemprop="publicationDate">1991-07-23</time></td>
      </tr>
      <tr itemprop="forwardReferences" itemscope repeat>
        <td><span itemprop="publicationNumber">US11234567B2</span></td>
        <td itemprop="title">Later method</td>
      </tr>
      <tr itemprop="docdbFamily" itemscope repeat>
        <td><span itemprop="publicationNumber">EP3019619A2</span></td>
      </tr>
      <tr itemprop="docdbFamily" itemscope repeat>
        <td><span itemprop="publicationNumber">WO2015006747A2</span></td>
      </tr>
      <span itemprop="Code">A61K</span><span itemprop="Code">A61K48/00</span><span itemprop="Code">A61K48/0055</span>
      </body></html>
    `;
    const parsed = parseGooglePatentHtml(html);
    expect(parsed.title).toBe('Compositions comprising synthetic polynucleotides');
    expect(parsed.publication_number).toBe('US11027025B2');
    expect(parsed.publication_date).toBe('2021-06-08');
    expect(parsed.filing_date).toBe('2014-07-11');
    expect(parsed.priority_date).toBe('2013-07-11');
    expect(parsed.inventors).toEqual(['Stephen G. Hoge']);
    expect(parsed.assignee).toEqual(['ModernaTx Inc']);
    expect(parsed.legal_status).toBe('Active');
    expect(parsed.abstract).toContain('modified mRNA');
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.claims[0].text).toContain('1. A composition');
    expect(parsed.backward_references[0].publication_number).toBe('US5034506');
    expect(parsed.backward_references[0].title).toBe('Nucleotide delivery');
    expect(parsed.forward_references[0].publication_number).toBe('US11234567B2');
    expect(parsed.family_members).toEqual(['EP3019619A2', 'WO2015006747A2']);
    // maximal CPC symbols only (no ancestors)
    expect(parsed.cpc).toEqual(['A61K48/0055']);
  });

  test('parses sparse EP-style page (no refs/classifications) without crashing', async () => {
    const { parseGooglePatentHtml } = await import('../../entities/patent/detail/parse.js');
    const html = `
      <meta name="DC.title" content="Verfahren zur Herstellung">
      <span itemprop="publicationNumber">EP1000000A1</span>
      <div class="abstract">Ein Verfahren.</div>
    `;
    const parsed = parseGooglePatentHtml(html);
    expect(parsed.title).toBe('Verfahren zur Herstellung');
    expect(parsed.publication_number).toBe('EP1000000A1');
    expect(parsed.abstract).toBe('Ein Verfahren.');
    expect(parsed.claims).toEqual([]);
    expect(parsed.backward_references).toEqual([]);
    expect(parsed.family_members).toEqual([]);
    expect(parsed.cpc).toEqual([]);
  });

  test('decodeHtmlEntities handles common entities', async () => {
    const { decodeHtmlEntities } = await import('../../entities/patent/detail/parse.js');
    expect(decodeHtmlEntities('a&amp;b&lt;c&gt;d&quot;e&#39;f&hellip;g')).toBe("a&b<c>d\"e'f…g");
    expect(decodeHtmlEntities('&#65;&#66;')).toBe('AB');
  });
});

describe('wayback fallback', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('findWaybackSnapshot returns id_ URL when snapshot exists', async () => {
    const { findWaybackSnapshot } = await import('../../entities/patent/detail/wayback.js');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(JSON.stringify({
        archived_snapshots: { closest: { url: 'https://web.archive.org/web/20260215174326/https://patents.google.com/patent/US11027025B2/en', timestamp: '20260215174326', status: '200' } },
      })),
    }) as any;
    const snap = await findWaybackSnapshot('https://patents.google.com/patent/US11027025B2/en');
    expect(snap?.timestamp).toBe('20260215174326');
    expect(snap?.idUrl).toContain('20260215174326id_/');
  });

  test('findWaybackSnapshot returns null when no snapshot', async () => {
    const { findWaybackSnapshot } = await import('../../entities/patent/detail/wayback.js');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(JSON.stringify({ archived_snapshots: {} })),
    }) as any;
    expect(await findWaybackSnapshot('https://patents.google.com/patent/EP3904939B1/en')).toBeNull();
  });

  test('fetchWaybackOriginal gunzips magic-byte gzip payloads', async () => {
    const { fetchWaybackOriginal } = await import('../../entities/patent/detail/wayback.js');
    const { gzipSync } = await import('node:zlib');
    const gz = gzipSync(Buffer.from('<html>decompressed</html>'));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)),
    }) as any;
    const out = await fetchWaybackOriginal('https://web.archive.org/web/1id_/x');
    expect(out).toBe('<html>decompressed</html>');
  });
});

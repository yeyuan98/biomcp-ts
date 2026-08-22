import { jest } from '@jest/globals';

const REQUIRED_TEMPLATE_KEY = 'showDocPerFamilyPref';

describe('patent search transforms', () => {
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
    const gp = await import('../../entities/patent/search/google-patents.js');
    gp.resetGooglePatentsBreaker();
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
    expect(response.patents.some(p => p._error)).toBe(true);
    expect(response.patents.some(p => p.publication_number === 'US11027025')).toBe(true);
    expect(response.total_hits?.uspto_odp).toBe(1);
    gp.resetGooglePatentsBreaker();
    (await import('../../connections/manager.js')).connectionManager.closeAll();
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
    expect(searchBodies[0][REQUIRED_TEMPLATE_KEY]).toBe('showEnglish');
    expect(searchBodies[0]['showDocFamilyPref']).toBeUndefined();
    expect((searchBodies[0].query as any).caseId).toBe(12345);
    expect((searchBodies[0].query as any).op).toBe('AND');
    const filters = (searchBodies[0].query as any).databaseFilters as Array<{ databaseName: string }>;
    expect(filters.map(f => f.databaseName)).toEqual(['US-PGPUB', 'USPAT', 'USOCR']);
    // Header contracts: session handshake and search auth
    const sessionHeaders = (global.fetch as any).mock.calls[0][1].headers as Record<string, string>;
    expect(sessionHeaders['X-Access-Token']).toBe('null');
    expect(sessionHeaders['Referer']).toBe('https://ppubs.uspto.gov/pubwebapp/');
    const searchHeaders = (global.fetch as any).mock.calls[1][1].headers as Record<string, string>;
    expect(searchHeaders['X-Access-Token']).toBe('tok-1');
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

describe('query builders (assert exact upstream request construction)', () => {
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

  test('searchPpubs builds verified date syntax and field suffixes', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    const bodies: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/users/me/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'x-access-token': 'tok-1', 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ userCase: { caseId: 1 } })),
        });
      }
      bodies.push(init.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ patents: [] })),
      });
    }) as any;

    await client.search('', {});
    const { searchPpubs } = await import('../../entities/patent/search/ppubs.js');
    await searchPpubs('crispr', {
      assignee: 'Moderna',
      inventor: 'Hoge',
      cpc: 'C12N15/11',
      date_range: '2020-01-01/2024-06-30',
    });
    expect(JSON.parse(bodies[0]).query.q).toBe('');
    expect(JSON.parse(bodies[1]).query.q).toBe(
      'crispr AND (Moderna).as. AND (Hoge).in. AND (C12N15/11).cpc. AND @pd>=20200101<=20240630'
    );
    client.close();
  });

  test('searchOdp builds escaped Lucene with date range', async () => {
    process.env.USPTO_API_KEY = 'u';
    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn().mockImplementation((url: any, init?: any) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      const payload = JSON.stringify({ count: 0, patentFileWrapperDataBag: [] });
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(payload),
      });
    }) as any;

    const { searchOdp } = await import('../../entities/patent/search/odp.js');
    await searchOdp('crispr "gene editing"', {
      assignee: 'Say "hi" Inc',
      date_range: '2023-01-01/2024-12-31',
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].body.q).toBe(
      '(crispr "gene editing") AND applicationMetaData.firstApplicantName:"Say \\"hi\\" Inc" AND applicationMetaData.filingDate:[2023-01-01 TO 2024-12-31]'
    );
    expect(posts[0].body.pagination).toEqual({ offset: 0, limit: 10 });
    connectionManager.closeAll();
  });

  test('searchOps builds grouped CQL (precedence-safe) and asserts auth headers', async () => {
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    const calls: Array<{ url: string; headers: Headers; body?: string }> = [];
    global.fetch = jest.fn().mockImplementation((url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/auth/accesstoken')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ access_token: 'tok', expires_in: 1199 })),
        });
      }
      calls.push({ url: u, headers: init.headers as Headers, body: init.body });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({
          'ops:world-patent-data': {
            'ops:biblio-search': {
              '@total-result-count': '7',
              'ops:search-result': { 'exchange-documents': { 'exchange-document': [] } },
            },
          },
        })),
      });
    }) as any;

    const { searchOps } = await import('../../entities/patent/search/ops.js');
    const result = await searchOps('crispr cas9', { assignee: 'moderna', limit: 5, offset: 10 });
    expect(result.total).toBe(7);
    const searchCall = calls.find(c => c.url.includes('search/biblio'));
    expect(searchCall?.url).toContain(encodeURIComponent('(ti="crispr cas9" OR ab="crispr cas9") AND pa="moderna"'));
    expect(searchCall?.url).toContain('Range=11-15');
    expect((searchCall?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    expect((searchCall?.headers as Record<string, string>)['Accept']).toBe('application/json');
    const tokenCall = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/auth/accesstoken'));
    expect((tokenCall[1].headers as Record<string, string>)['Authorization']).toMatch(/^Basic /);
    expect(tokenCall[1].body).toBe('grant_type=client_credentials');
    (await import('../../entities/patent/ops-client.js')).opsClient.close();
  });
});

describe('fetchPpubsClaims splitting', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('splits claimsHtml into numbered claims and resolves guid by .pn. search', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    const searchQueries: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/users/me/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'x-access-token': 'tok-1', 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ userCase: { caseId: 1 } })),
        });
      }
      if (u.includes('/api/searches/searchWithBeFamily')) {
        searchQueries.push(JSON.parse(init.body).query.q);
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            patents: [{ guid: 'US-11027025-B2', type: 'USPAT' }],
          })),
        });
      }
      if (u.includes('/api/patents/highlight/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            guid: 'US-11027025-B2',
            type: 'USPAT',
            publicationReferenceDocumentNumber: '11027025',
            inventionTitle: 'Compositions',
            numberOfClaims: 3,
            claimsHtml: '<div class="claims"><div num="1" class="claim"><div class="claim-text">1. A composition.</div></div><div num="2" class="claim"><div class="claim-text">2. The composition of claim 1.</div></div><div num="3" class="claim"><div class="claim-text">3. A method.</div></div></div>',
          })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { fetchPpubsClaims } = await import('../../entities/patent/detail/ppubs.js');
    const claims = await fetchPpubsClaims('US11027025B2');
    expect(searchQueries).toEqual(['("11027025").pn.']);
    expect(claims.number_of_claims).toBe(3);
    expect(claims.claims).toHaveLength(3);
    expect(claims.claims[0]).toBe('1. A composition.');
    expect(claims.claims[1]).toBe('2. The composition of claim 1.');
    client.close();
  });
});

describe('patentGet orchestration (chains)', () => {
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

  function ppubsMock(core: Record<string, unknown>) {
    return jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('archive.org')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ archived_snapshots: {} })),
        });
      }
      if (u.includes('patents.google.com')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers(),
          text: () => Promise.resolve('Sorry... automated queries'),
        });
      }
      if (u.includes('/api/users/me/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'x-access-token': 'tok-1', 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ userCase: { caseId: 1 } })),
        });
      }
      if (u.includes('/api/searches/searchWithBeFamily')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            patents: [{ guid: 'US-11027025-B2', type: 'USPAT' }],
          })),
        });
      }
      if (u.includes('/api/patents/highlight/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            guid: 'US-11027025-B2',
            type: 'USPAT',
            publicationReferenceDocumentNumber: '11027025',
            inventionTitle: 'Compositions comprising synthetic polynucleotides',
            ...core,
          })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    });
  }

  test('US core falls through GP(blocked) → wayback(miss) → PPUBS', async () => {
    global.fetch = ppubsMock({ abstractHtml: '<p>The present invention.</p>' }) as any;
    const { patentGet } = await import('../../entities/patent/detail/index.js');
    const result = await patentGet('US11027025B2');
    expect(result.publication_number).toBe('US11027025B2');
    expect(result.title).toBe('Compositions comprising synthetic polynucleotides');
    expect(result.abstract).toBe('The present invention.');
  });

  test('all-sources-failed sections capture errors without throwing', async () => {
    // citations section: no OPS creds; GP blocked; wayback miss; PPUBS doc has no usRef data
    global.fetch = ppubsMock({ usRefPatentNumber: [], foreignRefPatentNumber: [] }) as any;
    const { patentGet } = await import('../../entities/patent/detail/index.js');
    const result = await patentGet('US11027025B2', ['citations']);
    expect(result.sections?.citations).toEqual({ error: expect.stringContaining('All sources failed') });
  });

  test('unknown section yields explicit error entry', async () => {
    global.fetch = ppubsMock({}) as any;
    const { patentGet } = await import('../../entities/patent/detail/index.js');
    const result = await patentGet('US11027025B2', ['nonsense_section' as string]);
    expect(result.sections?.nonsense_section).toEqual({ error: expect.stringContaining('Unknown section') });
  });

  test("'all' expands to every section", async () => {
    global.fetch = ppubsMock({
      abstractHtml: '<p>Abstract.</p>',
      claimsHtml: '<div num="1" class="claim">1. Claim one.</div>',
      usRefPatentNumber: ['US5034506'], usRefIssueDate: ['1991-07-23'], usRefPatenteeName: ['Doe'],
      foreignRefPatentNumber: [], foreignRefPubDate: [],
      cpcInventiveFlattened: 'A61K9/51', ipcCodeFlattened: 'C12N15/11',
      patentFamilyMembers: ['EP3019619A2'],
    }) as any;
    const { patentGet } = await import('../../entities/patent/detail/index.js');
    const result = await patentGet('US11027025B2', ['all']);
    for (const section of ['abstract', 'claims', 'citations', 'family', 'classifications']) {
      expect(result.sections?.[section]).toBeDefined();
      expect((result.sections?.[section] as any).error).toBeUndefined();
    }
    const citations = result.sections!.citations as any;
    expect(citations.backward[0].publication_number).toBe('US5034506');
    const claims = result.sections!.claims as any;
    expect(claims.claims.length).toBeGreaterThan(0);
  });
});

describe('fetchGooglePatentDetail block-page detection', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('block page trips breaker and falls back to wayback snapshot', async () => {
    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    const { gzipSync } = await import('node:zlib');
    const gz = gzipSync(Buffer.from(
      '<meta name="DC.title" content="Wayback title"><span itemprop="publicationNumber">US11027025B2</span>'
    ));
    let googleDetailCalls = 0;
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('web.archive.org')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)),
        });
      }
      if (u.includes('archive.org/wayback/available')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            archived_snapshots: { closest: { url: 'x', timestamp: '20260215174326' } },
          })),
        });
      }
      if (u.includes('patents.google.com/patent/')) {
        googleDetailCalls++;
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html>Sorry... automated queries</html>'),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { fetchGooglePatentDetail } = await import('../../entities/patent/detail/google-patents.js');
    const parsed = await fetchGooglePatentDetail('US11027025B2');
    expect(parsed.title).toBe('Wayback title');
    expect(googleDetailCalls).toBe(1);
    connectionManager.closeAll();
  });

  test('both live and wayback unavailable → descriptive error', async () => {
    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('patents.google.com/patent/')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers(),
          text: () => Promise.resolve('Sorry...'),
        });
      }
      if (u.includes('archive.org')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ archived_snapshots: {} })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { fetchGooglePatentDetail } = await import('../../entities/patent/detail/google-patents.js');
    await expect(fetchGooglePatentDetail('US11027025B2')).rejects.toThrow(/unavailable for US11027025B2/);
    connectionManager.closeAll();
  });
});

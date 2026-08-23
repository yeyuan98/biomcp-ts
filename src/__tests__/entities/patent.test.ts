import { jest } from '@jest/globals';
import { HttpConnectionError } from '../../connections/errors.js';

const REQUIRED_TEMPLATE_KEY = 'showDocPerFamilyPref';

// Await a promise that internally sleeps on module timers (token-bucket rate
// limiters, throttle backoffs) under jest fake timers, stepping the clock
// until the promise settles.
async function advanceUntilSettled<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: { error: unknown } | undefined;
  p.then(
    v => { value = v; settled = true; },
    e => { failure = { error: e }; settled = true; },
  );
  while (!settled) {
    await jest.advanceTimersByTimeAsync(250);
  }
  if (failure) throw failure.error;
  return value as T;
}

// The token-bucket rate limiters only advance their lastRefill when the
// clock moves forward, so every install must start later than both real
// time (singleton clients construct their limiters at import) and any fake
// time a previous test reached.
const REAL_TIME_AT_LOAD = Date.now();
let fakeTimersInstalled = 0;
function installFakeTimers(): void {
  fakeTimersInstalled++;
  jest.useFakeTimers({ now: REAL_TIME_AT_LOAD + fakeTimersInstalled * 3_600_000 });
}

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

describe('seminal prior-art mining', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    installFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    delete process.env.EPO_OPS_CONSUMER_KEY;
    delete process.env.EPO_OPS_CONSUMER_SECRET;
    // Reset the ppubs singleton so later describes (notably the Date.now
    // budget-guard test) never inherit a cached session / limiter state.
    const { ppubsClient } = await import('../../entities/patent/ppubs-client.js');
    ppubsClient.close();
  });

  function jsonResp(payload: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(headers),
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    });
  }

  // Real PPUBS shapes captured live on 2026-08-23 for "mRNA display".
  // assigneeName matters: mining uses diversity sampling (max 2 docs per
  // assignee) and cross-assignee co-citation ranking.
  const POOL_GRANTS = [
    { guid: 'US-9347058-B2', type: 'USPAT', publicationReferenceDocumentNumber: '9347058', inventionTitle: 'Methods for the selection of binding proteins', score: 13.3, assigneeName: ['Bristol-Myers Squibb Company'] },
    { guid: 'US-11060085-B2', type: 'USPAT', publicationReferenceDocumentNumber: '11060085', inventionTitle: 'Methods for the selection of binding proteins', score: 13.2, assigneeName: ['Bristol-Myers Squibb Company'] },
    { guid: 'US-11913137-B2', type: 'USPAT', publicationReferenceDocumentNumber: '11913137', inventionTitle: 'Methods for the selection of binding proteins', score: 13.1, assigneeName: ['Compound Therapeutics Inc'] },
  ];
  const POOL_APPS = [
    { guid: 'US-20140179551-A1', type: 'US-PGPUB', publicationReferenceDocumentNumber: '20140179551', inventionTitle: 'METHODS FOR THE SELECTION OF BINDING PROTEINS', score: 13.35, assigneeName: ['Bristol-Myers Squibb Company'] },
  ];
  // The three granted top hits all cite the Szostak PCT in three different
  // raw formats (verified live); two also share a US reference.
  const DOC_REFS: Record<string, unknown> = {
    'US-9347058-B2': { foreignRefPatentNumber: ['WO98/56915', 'WO2008/031098'], usRefPatentNumber: ['5,034,506'] },
    'US-11060085-B2': { foreignRefPatentNumber: ['9856915', 'WO99/36569'], usRefPatentNumber: ['5034506'] },
    'US-11913137-B2': { foreignRefPatentNumber: ['WO1998/056915', '2001/64942'], usRefPatentNumber: ['US5034506'] },
  };

  function ppubsSeminalMock(opts: {
    pool: unknown[];
    docs: Record<string, unknown>;
    mainPatents?: unknown[];
    searchCalls?: { count: number };
  }) {
    return jest.fn().mockImplementation((url: any, init?: any) => {
      const u = String(url);
      if (u.includes('patents.google.com')) {
        return Promise.reject(new Error('no network')); // google_patents leg fails softly
      }
      if (u.includes('/api/users/me/session')) {
        return jsonResp({ userCase: { caseId: 1 } }, { 'x-access-token': 'tok-1', 'content-type': 'application/json' });
      }
      if (u.includes('/api/searches/searchWithBeFamily')) {
        const body = JSON.parse(init.body);
        if (opts.searchCalls) opts.searchCalls.count++;
        if (body.pageCount >= 100) return jsonResp({ patents: opts.pool, numberOfFamilies: 100 });
        return jsonResp({ patents: opts.mainPatents ?? opts.pool.slice(0, 2), numberOfFamilies: 100 });
      }
      if (u.includes('/api/patents/highlight/')) {
        for (const [guid, doc] of Object.entries(opts.docs)) {
          if (u.includes(guid)) return jsonResp(doc);
        }
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    });
  }

  test('parsePatentRef canonicalizes all real PPUBS citation formats', async () => {
    const { parsePatentRef, refKey } = await import('../../entities/patent/search/seminal.js');
    const k = (raw: string, origin: 'us' | 'foreign' = 'foreign') => refKey(parsePatentRef(raw, origin)!);
    // every observed raw form of the Szostak PCT canonicalizes identically
    expect(k('WO98/56915')).toBe('WO:1998:56915');
    expect(k('9856915')).toBe('WO:1998:56915');
    expect(k('WO1998/056915')).toBe('WO:1998:56915');
    // other observed formats
    expect(k('WO-2014180569')).toBe('WO:2014:180569');
    expect(k('2015/103037')).toBe('WO:2015:103037');
    expect(k('2019/060835')).toBe('WO:2019:60835');
    expect(k('90/02809')).toBe('WO:1990:2809');
    expect(k('2001/64942')).toBe('WO:2001:64942');
    expect(k('WO02/32925')).toBe('WO:2002:32925');
    expect(k('WO2008/031098')).toBe('WO:2008:31098');
    // US refs and publication numbers
    expect(k('5,034,506', 'us')).toBe('US:5034506');
    expect(k('US5034506', 'us')).toBe('US:5034506');
    expect(refKey(parsePatentRef('US9347058B2')!)).toBe('US:9347058');
    expect(refKey(parsePatentRef('WO2015006747A2')!)).toBe('WO:2015:6747');
    expect(refKey(parsePatentRef('EP3904939B1')!)).toBe('EP:3904939');
    // negatives: origin matters, serials distinguish, junk rejected
    expect(k('9856915', 'us')).toBe('US:9856915');
    expect(k('9856915', 'us')).not.toBe(k('9856915', 'foreign'));
    expect(k('WO98/56916')).not.toBe(k('WO98/56915'));
    expect(parsePatentRef('crispr')).toBeNull();
    expect(parsePatentRef('')).toBeNull();
  });

  test('patentSearch default-on mines co-cited seminal art (keyless: WO form + actionable note)', async () => {
    const searchCalls = { count: 0 };
    global.fetch = ppubsSeminalMock({
      pool: [...POOL_APPS, ...POOL_GRANTS],
      docs: DOC_REFS,
      mainPatents: [POOL_GRANTS[0], POOL_APPS[0]],
      searchCalls,
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', { limit: 5 }));
    // main page intact (2 real results + gp _error marker)
    expect(response.patents.filter(p => !p._error)).toHaveLength(2);
    // one extra ppubs search for the mining pool
    expect(searchCalls.count).toBe(2);
    // co-citation entries: shared US ref + the Szostak PCT in all raw formats
    expect(response.seminal_prior_art).toHaveLength(2);
    const wo = response.seminal_prior_art!.find(e => e.publication_number.startsWith('WO'));
    expect(wo?.publication_number).toBe('WO1998/056915');
    expect(wo?.co_cited_by).toBe(3);
    expect(wo?.cited_by).toEqual(['US9347058B2', 'US11060085B2', 'US11913137B2']);
    expect(wo?.note).toContain('externally');
    const us = response.seminal_prior_art!.find(e => e.publication_number === 'US5034506');
    expect(us?.co_cited_by).toBe(3);
    expect(us?.note).toBeUndefined();
    expect(response.mined_count).toBe(3);
    // quoted query → no GIGO tip
    expect(response.seminal_note ?? '').not.toContain('quote');
  });

  test('seminal: false skips mining entirely (single ppubs search, no seminal fields)', async () => {
    const searchCalls = { count: 0 };
    global.fetch = ppubsSeminalMock({
      pool: [...POOL_APPS, ...POOL_GRANTS],
      docs: DOC_REFS,
      mainPatents: [POOL_GRANTS[0]],
      searchCalls,
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', { seminal: false }));
    expect(searchCalls.count).toBe(1);
    expect(response.seminal_prior_art).toBeUndefined();
    expect(response.mined_count).toBeUndefined();
  });

  test('unquoted multi-word query appends the precision tip to seminal_note', async () => {
    global.fetch = ppubsSeminalMock({
      pool: [...POOL_APPS, ...POOL_GRANTS],
      docs: DOC_REFS,
      mainPatents: [POOL_GRANTS[0]],
    }) as any;
    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('mRNA display', {}));
    expect(response.seminal_note).toContain('quote an exact concept phrase');
  });

  test('too few granted docs in pool → empty entries + explanatory note', async () => {
    global.fetch = ppubsSeminalMock({
      pool: POOL_APPS, // applications only
      docs: {},
      mainPatents: [POOL_APPS[0]],
    }) as any;
    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', {}));
    expect(response.patents.filter(p => !p._error)).toHaveLength(1);
    expect(response.seminal_prior_art).toEqual([]);
    expect(response.seminal_note).toContain('too few granted');
    expect(response.mined_count).toBe(0);
  });

  test('no commonly-cited reference → empty entries + precision note', async () => {
    global.fetch = ppubsSeminalMock({
      pool: POOL_GRANTS,
      docs: {
        'US-9347058-B2': { foreignRefPatentNumber: ['WO2008/031098'] },
        'US-11060085-B2': { foreignRefPatentNumber: ['WO99/36569'] },
        'US-11913137-B2': { foreignRefPatentNumber: ['2001/64942'] },
      },
      mainPatents: [POOL_GRANTS[0]],
    }) as any;
    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', {}));
    expect(response.seminal_prior_art).toEqual([]);
    expect(response.seminal_note).toContain('no commonly-cited reference');
  });

  test('references already on the visible page are excluded from entries', async () => {
    global.fetch = ppubsSeminalMock({
      pool: POOL_GRANTS,
      docs: DOC_REFS,
      // the shared US reference IS a visible result here
      mainPatents: [POOL_GRANTS[0], { guid: 'US-5034506-A', type: 'USPAT', publicationReferenceDocumentNumber: '5034506', inventionTitle: 'Nucleotide delivery', score: 12 }],
    }) as any;
    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', {}));
    expect(response.seminal_prior_art!.map(e => e.publication_number)).toEqual(['WO1998/056915']);
  });

  test('mining failures degrade to a note without breaking the search', async () => {
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('patents.google.com')) return Promise.reject(new Error('no network'));
      if (u.includes('/api/users/me/session')) {
        return jsonResp({ userCase: { caseId: 1 } }, { 'x-access-token': 'tok-1', 'content-type': 'application/json' });
      }
      if (u.includes('/api/searches/searchWithBeFamily')) {
        return jsonResp({ patents: POOL_GRANTS, numberOfFamilies: 100 });
      }
      return Promise.reject(new Error(`unexpected ${u}`)); // getDocument fails
    }) as any;
    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', {}));
    expect(response.patents.filter(p => !p._error)).toHaveLength(3);
    expect(response.seminal_prior_art).toEqual([]);
    expect(response.seminal_note).toContain('too few granted documents yielded reference data');
  });

  test('non-200 getDocument bodies do not inflate the mined denominator', async () => {
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('patents.google.com')) return Promise.reject(new Error('no network'));
      if (u.includes('/api/users/me/session')) {
        return jsonResp({ userCase: { caseId: 1 } }, { 'x-access-token': 'tok-1', 'content-type': 'application/json' });
      }
      if (u.includes('/api/searches/searchWithBeFamily')) {
        return jsonResp({ patents: POOL_GRANTS, numberOfFamilies: 100 });
      }
      if (u.includes('/api/patents/highlight/')) {
        // 9347058: OK + refs; the other two: HTTP 500 with a JSON error body
        // (would parse fine but must NOT count as mined docs).
        if (u.includes('US-9347058-B2')) return jsonResp(DOC_REFS['US-9347058-B2']);
        return {
          ok: false,
          status: 500,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ error: 'boom' })),
        };
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;
    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', {}));
    expect(response.mined_count).toBe(1);
    expect(response.seminal_prior_art).toEqual([]);
    expect(response.seminal_note).toContain('too few granted documents yielded reference data');
  });

  test('with OPS creds, WO candidates resolve to the earliest granted US family member', async () => {
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    const familyPayload = {
      'ops:world-patent-data': {
        'ops:patent-family': {
          'ops:family-member': [
            {
              'publication-reference': {
                'document-id': [{
                  '@document-id-type': 'docdb',
                  country: { '$': 'US' }, 'doc-number': { '$': '6261804' }, kind: { '$': 'B1' }, date: { '$': '20010717' },
                }],
              },
            },
            {
              'publication-reference': {
                'document-id': [{
                  '@document-id-type': 'docdb',
                  country: { '$': 'US' }, 'doc-number': { '$': '20010044108' }, kind: { '$': 'A1' }, date: { '$': '20011122' },
                }],
              },
            },
          ],
        },
      },
    };
    const biblioPayload = {
      'ops:world-patent-data': {
        'exchange-documents': {
          'exchange-document': {
            '@country': 'US', '@doc-number': '6261804', '@kind': 'B1',
            'bibliographic-data': {
              'invention-title': [
                { '$': 'Fusions d´acide nucléique et de protéines', '@lang': 'fr' },
                { '$': 'Selection of proteins using RNA-protein fusions', '@lang': 'en' },
              ],
              'parties': {
                'applicants': { 'applicant': [{ 'applicant-name': { 'name': { '$': 'GEN HOSPITAL CORP [US]' } } }] },
              },
            },
          },
        },
      },
    };
    global.fetch = jest.fn().mockImplementation((url: any, init?: any) => {
      const u = String(url);
      if (u.includes('accesstoken')) {
        return jsonResp({ access_token: 'tok', expires_in: 1199 });
      }
      if (u.includes('/family/publication/epodoc/WO9856915')) {
        expect(init.headers['Authorization']).toBe('Bearer tok');
        return jsonResp(familyPayload, {});
      }
      if (u.includes('/published-data/publication/epodoc/US6261804/biblio')) {
        return jsonResp(biblioPayload, {});
      }
      if (u.includes('patents.google.com')) return Promise.reject(new Error('no network'));
      if (u.includes('ppubs.uspto.gov')) {
        // ppubs legs: no shared US ref this time (pure WO candidate)
        return ppubsSeminalMock({
          pool: POOL_GRANTS,
          docs: {
            'US-9347058-B2': { foreignRefPatentNumber: ['WO98/56915'] },
            'US-11060085-B2': { foreignRefPatentNumber: ['9856915'] },
            'US-11913137-B2': { foreignRefPatentNumber: ['WO1998/056915'] },
          },
          mainPatents: [POOL_GRANTS[0]],
        })(url, init);
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('"mRNA display"', {}));
    expect(response.seminal_prior_art).toHaveLength(1);
    const entry = response.seminal_prior_art![0];
    expect(entry.publication_number).toBe('US6261804B1');
    expect(entry.title).toBe('Selection of proteins using RNA-protein fusions');
    expect(entry.assignee).toBe('GEN HOSPITAL CORP [US]');
    expect(entry.note).toContain('WO1998/056915');
    expect(entry.co_cited_by).toBe(3);
    (await import('../../entities/patent/ops-client.js')).opsClient.close();
  });

  test('keyless GP resolution: correct page resolves; wrong-doc redirect is rejected', async () => {
    const { mineSeminalPriorArt } = await import('../../entities/patent/search/seminal.js');
    const { resetGooglePatentsBreaker } = await import('../../entities/patent/search/google-patents.js');
    resetGooglePatentsBreaker();
    // Two mined grants from different assignees both cite WO1999/060835.
    const pool = [
      { guid: 'US-11112222-B2', type: 'USPAT', assigneeName: ['Alpha Bio'] },
      { guid: 'US-22223333-B2', type: 'USPAT', assigneeName: ['Beta Bio'] },
      { guid: 'US-33334444-B2', type: 'USPAT', assigneeName: ['Alpha Bio'] },
    ];
    const docs = {
      'US-11112222-B2': { foreignRefPatentNumber: ['WO99/60835'] },
      'US-22223333-B2': { foreignRefPatentNumber: ['WO1999/060835'] },
      'US-33334444-B2': { foreignRefPatentNumber: ['WO99/60835'] },
    };
    const gpPage = (pubNum: string, title: string, family: string[], assignee: string) => `
      <meta name="DC.title" content="${title}">
      <meta name="DC.contributor" content="${assignee}" scheme="assignee">
      <span itemprop="publicationNumber">${pubNum}</span>
      ${family.map(m => `<tr itemprop="docdbFamily"><td><span itemprop="publicationNumber">${m}</span></td></tr>`).join('')}
    `;
    // First candidate (WO1998/031700 variant attempts) hits a wrong-doc page
    // (publicationNumber is a different patent, family does not contain it) —
    // must be rejected; the second candidate gets the correct page.
    let detailCalls = 0;
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('/api/users/me/session')) {
        return jsonResp({ userCase: { caseId: 1 } }, { 'x-access-token': 'tok-1', 'content-type': 'application/json' });
      }
      if (u.includes('/api/searches/searchWithBeFamily')) {
        return jsonResp({ patents: pool, numberOfFamilies: 50 });
      }
      if (u.includes('/api/patents/highlight/')) {
        for (const [guid, doc] of Object.entries(docs)) {
          if (u.includes(guid)) return jsonResp(doc);
        }
      }
      if (u.includes('patents.google.com/patent/')) {
        detailCalls++;
        if (u.includes('WO1999060835A2')) {
          // second variant attempt: correct page identifying as WO1999060835A2
          return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: () => Promise.resolve(gpPage('WO1999060835A2', 'Cyclic peptide libraries', ['US6500888B1', 'EP1122334A1'], 'Gamma Mol')) };
        }
        // first variant attempt (A1): Google redirect served an UNRELATED doc
        return { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: () => Promise.resolve(gpPage('US9999000B2', 'Unrelated patent', ['US9999000B2'], 'WrongCorp')) };
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const outcome = await advanceUntilSettled(mineSeminalPriorArt('cyclic peptide display', [
      { publication_number: 'US11112222B2', source: 'ppubs' },
    ]));
    expect(outcome.entries).toHaveLength(1);
    const entry = outcome.entries[0];
    // wrong-doc pages rejected → resolved via the identity-validated page
    expect(entry.publication_number).toBe('US6500888B1');
    expect(entry.title).toBe('Cyclic peptide libraries');
    expect(entry.assignee).toBe('Gamma Mol');
    expect(entry.note).toContain('resolved via Google Patents');
    expect(detailCalls).toBeGreaterThanOrEqual(2);
    resetGooglePatentsBreaker();
  });
});

describe('patent search federation', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(async () => {
    originalFetch = global.fetch;
    (await import('../../entities/patent/ops-client.js')).resetOpsBackoff();
    installFakeTimers();
  });

  afterEach(async () => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    delete process.env.EPO_OPS_CONSUMER_KEY;
    delete process.env.EPO_OPS_CONSUMER_SECRET;
    delete process.env.USPTO_API_KEY;
    (await import('../../entities/patent/ops-client.js')).resetOpsBackoff();
    (await import('../../entities/patent/search/google-patents.js')).resetGooglePatentsBreaker();
  });

  test('OPS backoff: 2 consecutive failures exclude ops from auto mode; auth failures trip immediately; success resets', async () => {
    const ops = await import('../../entities/patent/ops-client.js');
    const { selectSearchBackends, worldwideCoverageNote } = await import('../../entities/patent/search/index.js');
    const gp = await import('../../entities/patent/search/google-patents.js');
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';

    ops.recordOpsFailure('EPO OPS search failed: HTTP 500 upstream error');
    expect(selectSearchBackends({})).toEqual(['ops', 'ppubs']); // 1 strike: still selected
    ops.recordOpsFailure('EPO OPS search failed: HTTP 500 upstream error');
    expect(ops.isOpsBackedOff()).toBe(true); // 2 strikes: excluded 15 min
    expect(selectSearchBackends({})).toEqual(['google_patents', 'ppubs']); // GP substitutes
    expect(selectSearchBackends({ source: 'ops' })).toEqual(['ops']); // explicit source bypasses

    ops.resetOpsBackoff();
    ops.recordOpsFailure('EPO OPS authentication failed. Verify EPO_OPS_CONSUMER_KEY / EPO_OPS_CONSUMER_SECRET. (HTTP 401)');
    expect(ops.isOpsBackedOff()).toBe(true); // auth-class: immediate trip

    // coverage note fires only when BOTH worldwide backends are out
    gp.resetGooglePatentsBreaker();
    expect(worldwideCoverageNote()).toBeUndefined(); // GP substitutes → no US-only note yet
    // simulate GP breaker open by tripping it through a network failure
    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } })) as any;
    await expect(gp.searchGooglePatents('crispr', {})).rejects.toThrow();
    expect(gp.isGooglePatentsBlocked()).toBe(true);
    const note = worldwideCoverageNote();
    expect(note).toMatch(/worldwide coverage unavailable/);
    expect(note).toMatch(/US-only/);
    connectionManager.closeAll();
  });

  test('patentSearch appends the US-only coverage note when ops backed off AND GP breaker open', async () => {
    const ops = await import('../../entities/patent/ops-client.js');
    const gp = await import('../../entities/patent/search/google-patents.js');
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    ops.recordOpsFailure('x');
    ops.recordOpsFailure('y'); // backoff active

    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      if (u.includes('api.uspto.gov')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ count: 0, patentFileWrapperDataBag: [] })),
        });
      }
      return Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }));
    }) as any;
    // Trip the GP breaker first (network error path)
    await expect(gp.searchGooglePatents('x', {})).rejects.toThrow();

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('crispr', { seminal: false }));
    expect(response.patents.some(p => p._note?.includes('worldwide coverage unavailable'))).toBe(true);
    expect(response.patents.some(p => p._error?.includes("'google_patents' failed"))).toBe(false); // breaker short-circuited, no burned call
    connectionManager.closeAll();
  });

  test('google_patents breaker trips on network errors (fetch failed / ETIMEDOUT)', async () => {
    const gp = await import('../../entities/patent/search/google-patents.js');
    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    gp.resetGooglePatentsBreaker();
    const fetchCalls: string[] = [];
    global.fetch = jest.fn().mockImplementation((url: any) => {
      fetchCalls.push(String(url));
      return Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT', errno: -110 } }));
    }) as any;

    await expect(gp.searchGooglePatents('crispr', {})).rejects.toThrow(/fetch failed/);
    expect(gp.isGooglePatentsBlocked()).toBe(true);
    await expect(gp.searchGooglePatents('crispr', {})).rejects.toThrow(/circuit open|unavailable/);
    expect(fetchCalls).toHaveLength(1); // short-circuit: second call hit no network
    connectionManager.closeAll();
    gp.resetGooglePatentsBreaker();
  });

  test('selectSearchBackends: ppubs always the US default; GP omitted when OPS present', async () => {
    const { selectSearchBackends } = await import('../../entities/patent/search/index.js');
    expect(selectSearchBackends({})).toEqual(['google_patents', 'ppubs']);
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    process.env.USPTO_API_KEY = 'u';
    expect(selectSearchBackends({})).toEqual(['ops', 'ppubs']);
    expect(selectSearchBackends({ source: 'ppubs' })).toEqual(['ppubs']);
    expect(selectSearchBackends({ source: 'uspto_odp' })).toEqual(['uspto_odp']);
  });

  test('patentSearch falls back ppubs→odp on hard failure with _note provenance', async () => {
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
      // google_patents live fetch (worldwide fallback without OPS creds) and
      // ppubs session handshake both fail hard (typed 503 → GP breaker).
      return Promise.reject(new HttpConnectionError('HTTP 503: Service Unavailable', 503));
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('crispr compositions', {}));
    expect(response.patents.some(p => p.publication_number === 'US11027025')).toBe(true);
    expect(response.patents.some(p => p._note && p._note.includes('ppubs') && p._note.includes('uspto_odp'))).toBe(true);
    expect(response.patents.some(p => p._error && p._error.includes('google_patents'))).toBe(true);
    expect(response.total_hits?.uspto_odp).toBe(1);
    expect(response.total_hits_basis?.uspto_odp).toBeDefined();
    expect(response.total_hits_basis?.ppubs).toBeUndefined();
    gp.resetGooglePatentsBreaker();
    (await import('../../connections/manager.js')).connectionManager.closeAll();
  });

  test('patentSearch: no odp fallback without key; _error surfaces for ppubs', async () => {
    const gp = await import('../../entities/patent/search/google-patents.js');
    gp.resetGooglePatentsBreaker();
    global.fetch = jest.fn().mockRejectedValue(new HttpConnectionError('HTTP 503: Service Unavailable', 503)) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('crispr', {}));
    const markers = response.patents.filter(p => p._error || p._note || p._hint);
    expect(markers.some(p => p._error?.includes("'ppubs' failed"))).toBe(true);
    expect(markers.some(p => p._error?.includes("'google_patents' failed"))).toBe(true);
    expect(markers.some(p => p._note)).toBe(false);
    // no USPTO ODP endpoint hit (no key configured → no fallback attempt)
    const calledUrls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calledUrls.some(u => u.includes('api.uspto.gov'))).toBe(false);
    gp.resetGooglePatentsBreaker();
    (await import('../../connections/manager.js')).connectionManager.closeAll();
  });

  test('patentSearch: budget guard skips ppubs→odp fallback when elapsed > 12s', async () => {
    process.env.USPTO_API_KEY = 'u';
    const gp = await import('../../entities/patent/search/google-patents.js');
    gp.resetGooglePatentsBreaker();
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    global.fetch = jest.fn().mockImplementation((url: any) => {
      now = 20_000; // simulate time passing while backends run
      return Promise.reject(new HttpConnectionError('HTTP 503: Service Unavailable', 503));
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('crispr', {}));
    expect(response.patents.some(p => p._error?.includes("'ppubs' failed"))).toBe(true);
    expect(response.patents.some(p => p._note)).toBe(false);
    const calledUrls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calledUrls.some(u => u.includes('api.uspto.gov'))).toBe(false);
    nowSpy.mockRestore();
    gp.resetGooglePatentsBreaker();
    (await import('../../connections/manager.js')).connectionManager.closeAll();
  });

  test('patentSearch: clean 0-hit search appends _hint guidance', async () => {
    const gp = await import('../../entities/patent/search/google-patents.js');
    gp.resetGooglePatentsBreaker();
    const odpSearch = jest.fn().mockImplementation((url: any) => {
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
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ patents: [], numberOfFamilies: 0 })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    });
    const gpSearch = jest.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({}),
    }));
    global.fetch = jest.fn().mockImplementation((url: any) => {
      const u = String(url);
      return u.includes('ppubs.uspto.gov') ? odpSearch(url) : gpSearch(url);
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('xyzzyplugh-nonexistent-concept', {}));
    expect(response.patents).toHaveLength(1);
    expect(response.patents[0]._hint).toContain('quoting an exact concept phrase');
    expect(response.patents[0].source).toBe('ppubs');
    gp.resetGooglePatentsBreaker();
    (await import('../../connections/manager.js')).connectionManager.closeAll();
  });

  test('patentSearch: exhausted relevance window (matches exist, page empty) gets a pagination hint', async () => {
    const gp = await import('../../entities/patent/search/google-patents.js');
    gp.resetGooglePatentsBreaker();
    global.fetch = jest.fn().mockImplementation((url: any) => {
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
        // matches exist (88k families) but the offset is beyond the bounded
        // relevance batch → empty page
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({ patents: [], numberOfFamilies: 88262 })),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({}),
      });
    }) as any;

    const { patentSearch } = await import('../../entities/patent/search/index.js');
    const response = await advanceUntilSettled(patentSearch('mRNA display', { offset: 100 }));
    expect(response.patents).toHaveLength(1);
    expect(response.patents[0]._hint).toContain('bounded relevance window');
    expect(response.total_hits?.ppubs).toBe(88262);
    gp.resetGooglePatentsBreaker();
    (await import('../../connections/manager.js')).connectionManager.closeAll();
  });

  test('orderFederatedByRelevance: scored results first (desc, stable), unscored after', async () => {
    const { orderFederatedByRelevance } = await import('../../entities/patent/search/index.js');
    const unscoredA = { publication_number: 'EP1', source: 'ops' as const };
    const unscoredB = { publication_number: 'EP2', source: 'ops' as const };
    const scored = [
      { publication_number: 'US1', relevance_score: 5, source: 'ppubs' as const },
      { publication_number: 'US2', relevance_score: 20, source: 'ppubs' as const },
      { publication_number: 'US3', relevance_score: 9, source: 'ppubs' as const },
    ];
    const ordered = orderFederatedByRelevance([unscoredA, ...scored, unscoredB]);
    expect(ordered.map(p => p.publication_number)).toEqual(['US2', 'US3', 'US1', 'EP1', 'EP2']);
    // No scores anywhere → order untouched
    expect(orderFederatedByRelevance([unscoredA, unscoredB])).toEqual([unscoredA, unscoredB]);
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

    await expect(gp.searchGooglePatents('crispr', {})).rejects.toBeInstanceOf(HttpConnectionError);
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
    installFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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

    const resp = await advanceUntilSettled(client.get('/published-data/search?q=x'));
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
    installFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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

    await advanceUntilSettled(client.search('crispr', { pageCount: 5 }));
    await advanceUntilSettled(client.search('crispr AND (moderna).as.', { pageCount: 5 }));

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

    const resp = await advanceUntilSettled(client.search('crispr', {}));
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

describe('proxy-aware global fetch', () => {
  test('proxy module self-initializes safely and reports status', async () => {
    const { proxyStatus, configureProxyDispatcher } = await import('../../connections/proxy.js');
    // In CI/dev environments with proxy env set (this repo's environment
    // has HTTPS_PROXY), the module-scope init must have installed the
    // dispatcher; without proxy env it stays a no-op. Either way: no throw,
    // and a descriptive status.
    const hasProxyEnv = !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
    expect(proxyStatus.configured).toBe(hasProxyEnv);
    expect(proxyStatus.detail).toBeTruthy();
    // Re-running init is idempotent and never throws
    expect(() => configureProxyDispatcher()).not.toThrow();
  });
});

describe('query builders (assert exact upstream request construction)', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    installFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    delete process.env.EPO_OPS_CONSUMER_KEY;
    delete process.env.EPO_OPS_CONSUMER_SECRET;
    delete process.env.USPTO_API_KEY;
  });

  test('searchPpubs builds verified date syntax and field suffixes; relevance default maps to score desc', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    const bodies: Array<Record<string, unknown>> = [];
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
      bodies.push(JSON.parse(init.body));
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ patents: [], numberOfFamilies: 0 })),
      });
    }) as any;

    const { searchPpubs } = await import('../../entities/patent/search/ppubs.js');
    await advanceUntilSettled(searchPpubs('crispr', {
      assignee: 'Moderna',
      inventor: 'Hoge',
      cpc: 'C12N15/11',
      date_range: '2020-01-01/2024-06-30',
    }));
    expect((bodies[0] as any).query.q).toBe(
      'crispr AND (Moderna).as. AND (Hoge).in. AND (C12N15/11).cpc. AND @pd>=20200101<=20240630'
    );
    // Default sort_by = relevance → score desc, always start: 0 (verified:
    // server ignores `start` under score sort and pages client-side)
    expect((bodies[0] as any).sort).toBe('score desc');
    expect((bodies[0] as any).start).toBe(0);

    await advanceUntilSettled(searchPpubs('crispr', { sort_by: 'recency', limit: 5, offset: 10 }));
    expect((bodies[1] as any).sort).toBe('date_publ desc');
    expect((bodies[1] as any).start).toBe(10);
    expect((bodies[1] as any).pageCount).toBe(5);
    client.close();
  });

  test('searchPpubs relevance mode slices client-side and prefers numberOfFamilies total', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    const docs = Array.from({ length: 12 }, (_, i) => ({
      guid: `US-1102700${i}-B2`,
      publicationReferenceDocumentNumber: `1102700${i}`,
      type: 'USPAT',
      inventionTitle: `Doc ${i}`,
      score: 10 - i,
    }));
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
      const body = JSON.parse(init.body);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({
          patents: docs.slice(0, body.pageCount),
          totalResults: 12,
          numberOfFamilies: 1830,
          numFound: 12,
        })),
      });
    }) as any;

    const { searchPpubs } = await import('../../entities/patent/search/ppubs.js');
    const page1 = await advanceUntilSettled(searchPpubs('mRNA display', { limit: 5 }));
    expect(page1.patents).toHaveLength(5);
    expect(page1.patents[0].relevance_score).toBe(10);
    expect(page1.total).toBe(1830);

    const page2 = await advanceUntilSettled(searchPpubs('mRNA display', { limit: 5, offset: 5 }));
    expect(page2.patents.map(p => p.title)).toEqual(['Doc 5', 'Doc 6', 'Doc 7', 'Doc 8', 'Doc 9']);
    client.close();
  });

  test('searchOdp AND-joins plain terms, preserves phrases, passes boolean syntax through', async () => {
    process.env.USPTO_API_KEY = 'u';
    const { connectionManager } = await import('../../connections/manager.js');
    connectionManager.closeAll();
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn().mockImplementation((url: any, init?: any) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ count: 0, patentFileWrapperDataBag: [] }),
      });
    }) as any;

    const { searchOdp, buildLuceneQueryClause } = await import('../../entities/patent/search/odp.js');

    // The pain-point case: plain multi-word queries must AND-join (upstream
    // default operator is OR — "mRNA display" matched 367k OLED patents)
    expect(buildLuceneQueryClause('mRNA display')).toBe('(mRNA AND display)');
    // User-quoted phrases survive verbatim
    expect(buildLuceneQueryClause('"mRNA display"')).toBe('("mRNA display")');
    expect(buildLuceneQueryClause('crispr "gene editing"')).toBe('(crispr AND "gene editing")');
    // Explicit boolean/field/range syntax passes through untouched
    expect(buildLuceneQueryClause('crispr OR cas9')).toBe('(crispr OR cas9)');
    expect(buildLuceneQueryClause('applicationMetaData.patentNumber:"11027025"')).toBe('(applicationMetaData.patentNumber:"11027025")');

    await searchOdp('crispr "gene editing"', {
      assignee: 'Say "hi" Inc',
      date_range: '2023-01-01/2024-12-31',
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].body.q).toBe(
      '(crispr AND "gene editing") AND applicationMetaData.firstApplicantName:"Say \\"hi\\" Inc" AND applicationMetaData.filingDate:[2023-01-01 TO 2024-12-31]'
    );
    expect(posts[0].body.pagination).toEqual({ offset: 0, limit: 10 });
    connectionManager.closeAll();
  });

  test('normalizeExchangeDocuments handles both live response shapes (dict-of-array and list-of-wrapped)', async () => {
    const { normalizeExchangeDocuments } = await import('../../entities/patent/search/ops.js');
    const doc = (n: string) => ({ '@country': { '$': 'US' }, '@doc-number': { '$': n }, '@kind': { '$': 'B2' } });
    // shape 1: {"exchange-document": [doc, doc]}
    expect(normalizeExchangeDocuments({ 'exchange-document': [doc('1'), doc('2')] })).toHaveLength(2);
    // shape 2 (verified live, ti+ab queries): [{exchange-document: doc}, ...]
    expect(normalizeExchangeDocuments([
      { 'exchange-document': doc('3') },
      { 'exchange-document': doc('4') },
      { 'exchange-document': doc('5') },
    ])).toHaveLength(3);
    // single doc (not array) and empty/garbage shapes
    expect(normalizeExchangeDocuments({ 'exchange-document': doc('6') })).toHaveLength(1);
    expect(normalizeExchangeDocuments({})).toEqual([]);
    expect(normalizeExchangeDocuments([{ 'other-key': {} }, null as any])).toEqual([]);
  });

  test('searchOps parses the list-of-wrapped exchange-documents shape (evaluator repro)', async () => {
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    const wrappedDoc = (c: string, n: string, kind: string) => ({
      'exchange-document': {
        '@country': c, '@doc-number': n, '@kind': kind,
        'bibliographic-data': {
          'invention-title': { '$': `Title ${n}`, '@lang': 'en' },
          'publication-reference': {
            'document-id': [{ '@document-id-type': 'docdb', country: { '$': c }, 'doc-number': { '$': n }, kind: { '$': kind }, date: { '$': '20250101' } }],
          },
        },
      },
    });
    global.fetch = jest.fn()
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ access_token: 'tok', expires_in: 1199 })),
      }))
      .mockImplementation(() => Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({
          'ops:world-patent-data': {
            'ops:biblio-search': {
              '@total-result-count': '24',
              'ops:search-result': {
                // the shape observed live that previously parsed as 0 docs
                'exchange-documents': [wrappedDoc('CN', '120624583', 'A'), wrappedDoc('WO', '2025006976', 'A1')],
              },
            },
          },
        })),
      })) as any;

    const { searchOps } = await import('../../entities/patent/search/ops.js');
    const result = await advanceUntilSettled(searchOps('mRNA display', { limit: 5 }));
    expect(result.patents).toHaveLength(2);
    expect(result.total).toBe(24);
    expect(result.patents[0].publication_number).toBe('CN120624583A');
    expect(result.patents[1].publication_number).toBe('WO2025006976A1');
    (await import('../../entities/patent/ops-client.js')).opsClient.close();
  });

  test('searchOps retries once on server-empty-with-total, then throws descriptive error', async () => {
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    const emptyWithTotal = () => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({
        'ops:world-patent-data': {
          'ops:biblio-search': {
            '@total-result-count': '24',
            'ops:search-result': { 'exchange-documents': { 'exchange-document': [] } },
          },
        },
      })),
    });
    global.fetch = jest.fn()
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ access_token: 'tok', expires_in: 1199 })),
      }))
      .mockImplementationOnce(emptyWithTotal as any)
      .mockImplementationOnce(emptyWithTotal as any) as any;

    const { searchOps } = await import('../../entities/patent/search/ops.js');
    await expect(advanceUntilSettled(searchOps('crispr', { limit: 5 }))).rejects.toThrow(/reported 24 total results but returned no documents/);
    // token call + two search attempts (retry uses the same Range)
    const searchCalls = (global.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('search/biblio'));
    expect(searchCalls).toHaveLength(2);
    expect(String(searchCalls[0][0])).toBe(String(searchCalls[1][0]));
    (await import('../../entities/patent/ops-client.js')).opsClient.close();
  });

  test('searchOps: client-side filtered-to-empty is a valid empty result (no throw)', async () => {
    process.env.EPO_OPS_CONSUMER_KEY = 'k';
    process.env.EPO_OPS_CONSUMER_SECRET = 's';
    const hit = {
      '@country': 'US', '@doc-number': '11027025', '@kind': 'B2',
      'bibliographic-data': {
        'publication-reference': {
          'document-id': [
            { '@document-id-type': 'docdb', date: { '$': '20210608' } },
          ],
        },
      },
    };
    global.fetch = jest.fn()
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve(JSON.stringify({ access_token: 'tok', expires_in: 1199 })),
      }))
      .mockImplementation(() => Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({
          'ops:world-patent-data': {
            'ops:biblio-search': {
              '@total-result-count': '24',
              'ops:search-result': { 'exchange-documents': { 'exchange-document': hit } },
            },
          },
        })),
      })) as any;

    const { searchOps } = await import('../../entities/patent/search/ops.js');
    // date_range excludes the only doc → empty patents, no error, single fetch
    const result = await advanceUntilSettled(searchOps('crispr', { date_range: '1990-01-01/1990-12-31' }));
    expect(result.patents).toEqual([]);
    const searchCalls = (global.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('search/biblio'));
    expect(searchCalls).toHaveLength(1);
    (await import('../../entities/patent/ops-client.js')).opsClient.close();
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
              'ops:search-result': {
                'exchange-documents': {
                  'exchange-document': {
                    '@country': { '$': 'US' },
                    '@doc-number': { '$': '11027025' },
                    '@kind': { '$': 'B2' },
                    'bibliographic-data': {},
                  },
                },
              },
            },
          },
        })),
      });
    }) as any;

    const { searchOps } = await import('../../entities/patent/search/ops.js');
    const result = await advanceUntilSettled(searchOps('crispr cas9', { assignee: 'moderna', limit: 5, offset: 10 }));
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
    installFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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
    const claims = await advanceUntilSettled(fetchPpubsClaims('US11027025B2'));
    expect(searchQueries).toEqual(['("11027025").pn.']);
    expect(claims.number_of_claims).toBe(3);
    expect(claims.claims).toHaveLength(3);
    expect(claims.claims[0]).toBe('1. A composition.');
    expect(claims.claims[1]).toBe('2. The composition of claim 1.');
    client.close();
  });

  test('num= markup WITHOUT inline numbering still splits (pins the num-div path itself)', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    global.fetch = jest.fn().mockImplementation((url: any) => {
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
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            patents: [{ guid: 'US-6261804-B1', type: 'USPAT' }],
          })),
        });
      }
      if (u.includes('/api/patents/highlight/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            guid: 'US-6261804-B1',
            type: 'USPAT',
            claimsHtml: '<div class="claims"><div num="1" class="claim"><div class="claim-text">A composition comprising a peptide library.</div></div><div num="2" class="claim"><div class="claim-text">A method of screening the library.</div></div></div>',
          })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { fetchPpubsClaims } = await import('../../entities/patent/detail/ppubs.js');
    const claims = await advanceUntilSettled(fetchPpubsClaims('US6261804B1'));
    // If the num-div splitter regresses, these divs have no inline "N." text,
    // so the text-split fallback cannot rescue them — this assertion fails.
    expect(claims.claims).toEqual([
      '1. A composition comprising a peptide library.',
      '2. A method of screening the library.',
    ]);
    expect(claims.number_of_claims).toBe(2);
    expect(claims._warn).toBeUndefined();
    client.close();
  });

  test('splits CLM-id markup when num= attributes are absent', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
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
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            patents: [{ guid: 'US-6261804-B1', type: 'USPAT' }],
          })),
        });
      }
      if (u.includes('/api/patents/highlight/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            guid: 'US-6261804-B1',
            type: 'USPAT',
            claimsHtml: '<div class="claims"><div id="CLM-00001" class="claim">A fusion protein.</div><div id="CLM-00002" class="claim">An isolated nucleic acid encoding the protein of claim 1.</div></div>',
          })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { fetchPpubsClaims } = await import('../../entities/patent/detail/ppubs.js');
    const claims = await advanceUntilSettled(fetchPpubsClaims('US6261804B1'));
    expect(claims.claims).toEqual([
      '1. A fusion protein.',
      '2. An isolated nucleic acid encoding the protein of claim 1.',
    ]);
    expect(claims.number_of_claims).toBe(2);
    expect(claims._warn).toBeUndefined();
    client.close();
  });

  test('splits unmarked claimsHtml via sequential text markers; references do not split claims', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    global.fetch = jest.fn().mockImplementation((url: any) => {
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
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            patents: [{ guid: 'US-6261804-B1', type: 'USPAT' }],
          })),
        });
      }
      if (u.includes('/api/patents/highlight/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            guid: 'US-6261804-B1',
            type: 'USPAT',
            claimsHtml: '<p>1. A composition comprising a peptide. 2. The composition of claim 1. 3. A method of screening. 4. The method of claim 3.</p>',
          })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { fetchPpubsClaims } = await import('../../entities/patent/detail/ppubs.js');
    const claims = await advanceUntilSettled(fetchPpubsClaims('US6261804B1'));
    expect(claims.claims).toHaveLength(4);
    expect(claims.claims[0]).toBe('1. A composition comprising a peptide.');
    expect(claims.claims[2]).toBe('3. A method of screening.');
    expect(claims.number_of_claims).toBe(4);
    expect(claims._warn).toBeUndefined();
    client.close();
  });

  test('unsplittable blob: single block + _warn; number_of_claims trusts upstream or undefined (never bogus 1)', async () => {
    const { PpubsClient } = await import('../../entities/patent/ppubs-client.js');
    const client = new PpubsClient();
    let docCount: number | null = 12; // first call: upstream count present
    global.fetch = jest.fn().mockImplementation((url: any) => {
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
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            patents: [{ guid: 'US-6261804-B1', type: 'USPAT' }],
          })),
        });
      }
      if (u.includes('/api/patents/highlight/')) {
        const numberOfClaims = docCount;
        docCount = null; // second call: upstream count absent
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve(JSON.stringify({
            guid: 'US-6261804-B1',
            type: 'USPAT',
            numberOfClaims,
            claimsHtml: '<p>What is claimed is a continuous narrative without any numbering markers.</p>',
          })),
        });
      }
      return Promise.reject(new Error(`unexpected ${u}`));
    }) as any;

    const { fetchPpubsClaims } = await import('../../entities/patent/detail/ppubs.js');
    const withUpstream = await advanceUntilSettled(fetchPpubsClaims('US6261804B1'));
    expect(withUpstream.claims).toHaveLength(1);
    expect(withUpstream.number_of_claims).toBe(12);
    expect(withUpstream._warn).toContain('could not be split');

    const withoutUpstream = await advanceUntilSettled(fetchPpubsClaims('US6261804B1'));
    expect(withoutUpstream.number_of_claims).toBeUndefined();
    expect(withoutUpstream._warn).toContain('could not be split');
    client.close();
  });

  test('splitPlainTextClaims unit: adjacency and reference immunity', async () => {
    const { splitPlainTextClaims } = await import('../../entities/patent/detail/ppubs.js');
    // adjacent markers with no space between period and next digit start
    expect(splitPlainTextClaims('1. First claim. 2. Second claim. 3. Third.')).toEqual([
      '1. First claim.',
      '2. Second claim.',
      '3. Third.',
    ]);
    // reference "of claim 1." must not break the sequence
    expect(splitPlainTextClaims('1. Base. 2. Dependent of claim 1. 3. Method.')).toHaveLength(3);
    // no believable sequence
    expect(splitPlainTextClaims('A narrative with no claim markers at all.')).toBeNull();
    expect(splitPlainTextClaims('99. Only one marker.')).toBeNull();
  });
});

describe('patentGet orchestration (chains)', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    installFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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
    const result = await advanceUntilSettled(patentGet('US11027025B2'));
    expect(result.publication_number).toBe('US11027025B2');
    expect(result.title).toBe('Compositions comprising synthetic polynucleotides');
    expect(result.abstract).toBe('The present invention.');
  });

  test('all-sources-failed sections capture errors without throwing', async () => {
    // citations section: no OPS creds; GP blocked; wayback miss; PPUBS doc has no usRef data
    global.fetch = ppubsMock({ usRefPatentNumber: [], foreignRefPatentNumber: [] }) as any;
    const { patentGet } = await import('../../entities/patent/detail/index.js');
    const result = await advanceUntilSettled(patentGet('US11027025B2', ['citations']));
    expect(result.sections?.citations).toEqual({ error: expect.stringContaining('All sources failed') });
  });

  test('unknown section yields explicit error entry', async () => {
    global.fetch = ppubsMock({}) as any;
    const { patentGet } = await import('../../entities/patent/detail/index.js');
    const result = await advanceUntilSettled(patentGet('US11027025B2', ['nonsense_section' as string]));
    expect(result.sections?.nonsense_section).toEqual({ error: expect.stringContaining('Unknown section') });
  });

  test('applyLimit slices only the claims array, never number_of_claims', async () => {
    const { applyLimit } = await import('../../server/tools/utils.js');
    const sections: Record<string, unknown> = {
      claims: { claims: ['a', 'b', 'c'], number_of_claims: 3, source: 'ppubs' },
    };
    applyLimit(sections, ['claims'], {}, { claims: ['claims'] }, 2);
    expect((sections.claims as any).claims).toEqual(['a', 'b']);
    expect((sections.claims as any).number_of_claims).toBe(3);
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
    const result = await advanceUntilSettled(patentGet('US11027025B2', ['all']));
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

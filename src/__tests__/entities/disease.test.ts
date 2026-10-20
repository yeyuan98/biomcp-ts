import { jest } from '@jest/globals';
import { diseaseSearch, diseaseGet, transformMyDiseaseResponse } from '../../entities/disease.js';
import { connectionManager } from '../../connections/manager.js';
import { parseMockUrl } from '../helpers/mock-url.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

// Fake-timer helpers (article.test.ts / patent.test.ts convention, see
// src/__tests__/README.md): token-bucket rate limiters only refill when the
// clock moves forward, so any fake-timer install must start later than real
// time AND later than the fake time any earlier install reached.
const REAL_TIME_AT_LOAD = Date.now();
let fakeTimersInstalled = 0;

function installFakeTimers(): void {
  fakeTimersInstalled++;
  jest.useFakeTimers({ now: REAL_TIME_AT_LOAD + fakeTimersInstalled * 3_600_000 });
}

// Await a promise that internally sleeps on module timers (token-bucket rate
// limiters) under fake timers, stepping the clock until the promise settles.
// Bounded per the citation.test.ts hygiene convention: a stuck promise fails
// fast with a named error instead of eating the jest timeout.
const SETTLE_MAX_ITERATIONS = 480;

async function advanceUntilSettled<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: { error: unknown } | undefined;
  p.then(
    v => { value = v; settled = true; },
    e => { failure = { error: e }; settled = true; },
  );
  let iterations = 0;
  while (!settled) {
    if (++iterations > SETTLE_MAX_ITERATIONS) {
      throw new Error(
        `promise never settled after ${SETTLE_MAX_ITERATIONS} iterations of jest.advanceTimersByTimeAsync(250)`,
      );
    }
    await jest.advanceTimersByTimeAsync(250);
  }
  if (failure) throw failure.error;
  return value as T;
}

describe('disease', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('diseaseSearch() calls connection with correct mydisease endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ hits: [{ name: 'Breast Cancer', diseaseid: 'C0006142' }] }),
    }) as any;

    await diseaseSearch('breast cancer');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mydisease.info');
    expect(callUrl).toContain('/query?');
    expect(callUrl).toContain('q=breast+cancer');
  });

  test('diseaseSearch() returns transformed results', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        hits: [{
          _id: 'MONDO:0007254',
          mondo: { label: 'Breast Cancer' },
          disease_ontology: { doid: 'DOID:1612' },
        }],
      }),
    }) as any;

    const results = await diseaseSearch('breast cancer');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Breast Cancer');
    expect(results[0].disease_id).toBe('MONDO:0007254');
    expect(results[0].doid).toBe('DOID:1612');
  });

  test('diseaseGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        _id: 'MONDO:0007254',
        mondo: { label: 'Breast Cancer' },
      }),
    }) as any;

    await diseaseGet('MONDO:0007254');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('mydisease.info');
    expect(callUrl).toContain('/disease/');
    expect(callUrl).toContain('MONDO');
  });

  test('diseaseGet() resolves a UMLS CUI to its document id, then fetches that id', async () => {
    // CUIs are not servable by /disease/{id} (404 live); the resolver must
    // query umls.umls (exactly that field path — plain `umls:"..."` and
    // mondo.xrefs.umls_cui return 0 hits) and fetch the resolved id.
    let callCount = 0;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Resolution query
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ hits: [{ _id: 'MONDO:0007254' }] }),
        });
      }
      // Direct fetch of the resolved id
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          _id: 'MONDO:0007254',
          mondo: { label: 'Breast Cancer' },
        }),
      });
    }) as any;

    const result = await diseaseGet('C0006142');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const resolveUrl = decodeURIComponent((global.fetch as any).mock.calls[0][0] as string).replace(/\+/g, ' ');
    expect(resolveUrl).toContain('/query?');
    expect(resolveUrl).toContain('umls.umls:"C0006142"');
    expect(resolveUrl).toContain('fields=_id');
    expect(resolveUrl).toContain('size=1');
    const fetchUrl = (global.fetch as any).mock.calls[1][0] as string;
    expect(fetchUrl).toContain('/disease/MONDO%3A0007254');
    expect(result.disease_id).toBe('MONDO:0007254');
    expect(result.name).toBe('Breast Cancer');
  });

  test('diseaseGet() falls back to the umls: curie and enriches the nameless stub via MedGen', async () => {
    // Live shape of the docstring's example: C0018794 resolves to HP:0012722,
    // a UMLS-sourced document whose own id /disease/ will not serve (404) —
    // the `umls:{cui}` curie form fetches the same document. That stub has
    // no mondo/disease_ontology name (issue #100), so the record's own
    // umls.umls CUI drives a MedGen esearch+esummary enrichment.
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: [{ _id: 'HP:0012722' }] }),
      }))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 404 }))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 404 }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          _id: 'HP:0012722',
          original_id: 'UMLS:C0018794',
          umls: { umls: 'C0018794' },
        }),
      }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ esearchresult: { idlist: ['42363'] } }),
      }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          result: {
            uids: ['42363'],
            '42363': {
              uid: '42363',
              conceptid: 'C0018794',
              title: 'Heart block',
              definition: { value: 'Impaired conduction of cardiac impulse.' },
            },
          },
        }),
      })) as any;

    const result = await diseaseGet('C0018794');

    const urls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(urls[0]).toContain('umls.umls');
    // Resolved id + its alt separator form both tried before the curie.
    expect(urls[1]).toContain('/disease/HP%3A0012722');
    expect(urls[2]).toContain('/disease/HP_0012722');
    expect(urls[3]).toContain('/disease/umls%3AC0018794');
    // MedGen enrichment legs on the shared eutils connection.
    const esearchUrl = new URL(urls[4]);
    const esummaryUrl = new URL(urls[5]);
    expect(esearchUrl.hostname).toBe('eutils.ncbi.nlm.nih.gov');
    expect(esearchUrl.pathname).toBe('/entrez/eutils/esearch.fcgi');
    expect(esearchUrl.searchParams.get('db')).toBe('medgen');
    expect(esearchUrl.searchParams.get('term')).toBe('C0018794');
    expect(esummaryUrl.pathname).toBe('/entrez/eutils/esummary.fcgi');
    expect(esummaryUrl.searchParams.get('db')).toBe('medgen');
    expect(esummaryUrl.searchParams.get('id')).toBe('42363');
    expect(result.disease_id).toBe('HP:0012722');
    expect(result.name).toBe('Heart block');
    expect(result.ontology).toBe('umls');
    expect(result.description).toBe('Impaired conduction of cardiac impulse.');
    expect(result._warning).toBeUndefined();
  });

  test('diseaseGet() never echoes the CUI as name when MedGen enrichment fails', async () => {
    // Same nameless stub as above, but the MedGen esearch leg fails: name
    // must be null (NOT the raw CUI) and a _warning must explain why.
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: [{ _id: 'HP:0012722' }] }),
      }))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 404 }))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 404 }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          _id: 'HP:0012722',
          original_id: 'UMLS:C0018794',
          umls: { umls: 'C0018794' },
        }),
      }))
      .mockImplementationOnce(() => Promise.reject(new Error('eutils unreachable'))) as any;

    const result = await diseaseGet('C0018794');

    expect(result.disease_id).toBe('HP:0012722');
    expect(result.name).not.toBe('C0018794');
    expect(result.name).toBeNull();
    expect(result.ontology).toBe('umls');
    expect(result._warning).toContain('HP:0012722');
    expect(result._warning).toContain('C0018794');
    expect(result._warning).toContain('no disease name');
  });

  test('diseaseGet() treats a MedGen conceptid mismatch as enrichment failure', async () => {
    // esearch's bare-term match is not exact: if the esummary doc belongs to
    // a different concept (conceptid !== CUI), the enrichment is discarded.
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hits: [{ _id: 'HP:0012722' }] }),
      }))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 404 }))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 404 }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          _id: 'HP:0012722',
          original_id: 'UMLS:C0018794',
          umls: { umls: 'C0018794' },
        }),
      }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ esearchresult: { idlist: ['99999'] } }),
      }))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          result: {
            uids: ['99999'],
            '99999': { uid: '99999', conceptid: 'C0006142', title: 'Breast Neoplasms' },
          },
        }),
      })) as any;

    const result = await diseaseGet('C0018794');

    expect(result.name).toBeNull();
    expect(result._warning).toBeDefined();
  });

  test('diseaseGet() retries the alternate curie form when the primary lookup fails', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          _id: 'MONDO:0007254',
          mondo: { label: 'Breast Cancer' },
        }),
      }) as any;

    const result = await diseaseGet('MONDO_0007254');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const urls = (global.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(urls[0]).toContain('/disease/MONDO_0007254');
    expect(urls[1]).toContain('/disease/MONDO%3A0007254');
    expect(result.disease_id).toBe('MONDO:0007254');
    expect(result.name).toBe('Breast Cancer');
  });

  test('diseaseGet() throws a descriptive error when no ID form resolves', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    await expect(diseaseGet('MONDO_9999999')).rejects.toThrow(/not found/);
    // Both separator forms attempted.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('diseaseGet() error lists UMLS CUI among the supported ID formats', async () => {
    // A CUI the resolver cannot resolve: resolution query misses, the umls:
    // curie fetch also 404s — the error must now advertise UMLS CUIs.
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((rawUrl: string) => {
      if (rawUrl.includes('/query')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hits: [] }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    }) as any;

    await expect(diseaseGet('C9999999')).rejects.toThrow(
      /Supported ID formats: MONDO:XXXXXXX, DOID:XXXXXXX, OMIM:XXXXXX, UMLS CUI \(e\.g\. C0018794\)/
    );
  });

  test('transformMyDiseaseResponse() maps fields correctly', () => {
    const input = {
      _id: 'MONDO:0007254',
      mondo: { label: 'Breast Cancer' },
      disease_ontology: { doid: 'DOID:1612', def: 'A malignant neoplasm of the breast.' },
    };

    const result = transformMyDiseaseResponse(input);

    expect(result).toEqual({
      name: 'Breast Cancer',
      disease_id: 'MONDO:0007254',
      description: 'A malignant neoplasm of the breast.',
      ontology: 'mondo',
    });
  });
});

// ============================================================
// diseaseGet gene_associations section (DisGeNET gda/summary)
// ============================================================
describe('diseaseGet gene_associations section (DisGeNET)', () => {
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

  test('queries gda/summary with normalized disease code and raw Authorization key', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (parseMockUrl(url).hostname === 'mydisease.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'C0006142',
            mondo: { label: 'Breast carcinoma' },
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

    const result = await diseaseGet('C0006142', ['gene_associations']);

    const calls = (global.fetch as any).mock.calls;
    const disgenetCall = calls.find((c: any[]) => parseMockUrl(c[0]).hostname === 'api.disgenet.com');
    expect(disgenetCall).toBeDefined();
    const url = new URL(disgenetCall[0] as string);
    expect(url.pathname).toBe('/api/v1/gda/summary');
    expect(url.searchParams.get('disease')).toBe('UMLS_C0006142');
    expect(url.searchParams.get('page_number')).toBe('0');
    // Raw (unprefixed) API key in Authorization header.
    expect((disgenetCall[1].headers as Headers).get('Authorization')).toBe('test-disgenet-key');

    const associations = result.sections!.gene_associations as any[];
    expect(associations).toHaveLength(1);
    expect(associations[0]).toEqual({
      gene_symbol: 'BRCA1',
      name: 'BRCA1',
      disease_name: 'Breast carcinoma',
      score: 0.9,
      pmids: 120,
      source: 'disgenet',
    });
  });

  test('normalizes colon-form MONDO ids to DisGeNET underscore form', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (parseMockUrl(url).hostname === 'mydisease.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            _id: 'MONDO:0007254',
            mondo: { label: 'Breast Cancer' },
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ payload: [], warnings: [] }),
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    }) as any;

    await diseaseGet('MONDO:0007254', ['gene_associations']);

    const disgenetCall = (global.fetch as any).mock.calls.find((c: any[]) => parseMockUrl(c[0]).hostname === 'api.disgenet.com');
    expect(disgenetCall).toBeDefined();
    const url = new URL(disgenetCall[0] as string);
    expect(url.searchParams.get('disease')).toBe('MONDO_0007254');
  });
});

// ============================================================
// diseaseGet gene_associations OpenTargets fallback (issue #84)
// ============================================================
describe('diseaseGet gene_associations OpenTargets fallback (issue #84)', () => {
  mockGlobalFetch();
  let originalEnv: string | undefined;

  const MY_DISEASE_DOC = {
    _id: 'MONDO:0005105',
    mondo: { label: 'melanoma' },
  };

  function otAssociatedTargetsReply(rows: unknown[], disease: Record<string, unknown> = { id: 'MONDO_0005105', name: 'melanoma' }) {
    return {
      ok: true,
      json: () => Promise.resolve({
        data: { disease: { ...disease, associatedTargets: { rows } } },
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    };
  }

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

  test('keyless: falls back to OpenTargets associatedTargets and tags rows opentargets', async () => {
    const otRows = [
      { target: { id: 'ENSG00000157764', approvedSymbol: 'BRAF' }, score: 0.92 },
      { target: { id: 'ENSG00000141510', approvedSymbol: 'TP53' }, score: 0.71 },
    ];
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mydisease.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MY_DISEASE_DOC),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (url.hostname === 'api.platform.opentargets.org') {
        return Promise.resolve(otAssociatedTargetsReply(otRows));
      }
      return Promise.reject(new Error(`unexpected url ${url.href}`));
    }) as any;

    const result = await diseaseGet('MONDO:0005105', ['gene_associations']);

    // DisGeNET is never called without a key.
    const calls = (global.fetch as any).mock.calls;
    expect(calls.some((c: any[]) => parseMockUrl(c[0]).hostname === 'api.disgenet.com')).toBe(false);

    // OT accepts the MONDO id directly in underscore efoId form.
    const otCalls = calls.filter((c: any[]) => parseMockUrl(c[0]).hostname === 'api.platform.opentargets.org');
    expect(otCalls).toHaveLength(1);
    const otBody = JSON.parse(otCalls[0][1].body as string);
    expect(otBody.variables).toEqual({ efoId: 'MONDO_0005105' });
    expect(otBody.query).toContain('associatedTargets');

    const associations = result.sections!.gene_associations as any[];
    expect(associations).toEqual([
      { gene_symbol: 'BRAF', name: 'BRAF', disease_name: 'melanoma', score: 0.92, source: 'opentargets' },
      { gene_symbol: 'TP53', name: 'TP53', disease_name: 'melanoma', score: 0.71, source: 'opentargets' },
    ]);
  });

  test('keyless + OT failing: honest combined error naming both reasons', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mydisease.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MY_DISEASE_DOC),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (url.hostname === 'api.platform.opentargets.org') {
        return Promise.reject(new Error('OT is down'));
      }
      return Promise.reject(new Error(`unexpected url ${url.href}`));
    }) as any;

    const result = await diseaseGet('MONDO:0005105', ['gene_associations']);

    const associations = result.sections!.gene_associations as any[];
    expect(associations).toHaveLength(1);
    expect(associations[0]._error).toContain('DisGeNET unavailable (');
    expect(associations[0]._error).toContain('DISGENET_API_KEY');
    expect(associations[0]._error).toContain('OpenTargets fallback also failed (');
    expect(associations[0]._error).toContain('OT is down');
  });

  test('keyed + DisGeNET erroring: still falls back to OpenTargets', async () => {
    process.env.DISGENET_API_KEY = 'test-disgenet-key';
    const otRows = [
      { target: { id: 'ENSG00000157764', approvedSymbol: 'BRAF' }, score: 0.9 },
    ];
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mydisease.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MY_DISEASE_DOC),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (url.hostname === 'api.disgenet.com') {
        return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
      }
      if (url.hostname === 'api.platform.opentargets.org') {
        return Promise.resolve(otAssociatedTargetsReply(otRows));
      }
      return Promise.reject(new Error(`unexpected url ${url.href}`));
    }) as any;

    const result = await diseaseGet('MONDO:0005105', ['gene_associations']);

    const associations = result.sections!.gene_associations as any[];
    expect(associations).toHaveLength(1);
    expect(associations[0].gene_symbol).toBe('BRAF');
    expect(associations[0].source).toBe('opentargets');
  });

  test('unresolvable id falls back to an OT disease-name search before associatedTargets', async () => {
    // A mydisease id OT's efoId argument does not accept directly: the
    // direct disease lookup returns null, so the resolved disease name
    // drives an OT search whose hit id feeds the associatedTargets query.
    //
    // Fake timers (issue #166): this is the only test in the file whose OT
    // leg makes THREE sequential opentargets requests (direct probe → name
    // search → associatedTargets), so the 500 ms token-bucket pacing sleeps
    // twice between calls. Real-time pacing raced the section's 8 s
    // fetchWithTimeout deadline and lost under local CPU oversubscription
    // (the section silently degraded to an `_error` row); driving the chain
    // on a fake clock makes the pacing virtual and the test hermetic.
    const otRows = [
      { target: { id: 'ENSG00000141510', approvedSymbol: 'TP53' }, score: 0.4 },
    ];
    const otBodies: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((input: any, init?: any) => {
      const url = parseMockUrl(input);
      if (url.hostname === 'mydisease.info') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ _id: 'DOID:9999', disease_ontology: { name: 'rare melanocytic neoplasm' } }),
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      }
      if (url.hostname === 'api.platform.opentargets.org') {
        const body = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        otBodies.push(body as Record<string, unknown>);
        if (typeof body.query === 'string' && body.query.includes('search(')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: { search: { hits: [{ id: 'EFO_0000616', name: 'melanoma', entity: 'disease' }] } },
            }),
            headers: new Headers({ 'content-type': 'application/json' }),
          });
        }
        // Direct efoId probe for the unknown id finds nothing; the probe for
        // the search-resolved id returns the associated targets.
        if (body.variables?.efoId === 'DOID_9999') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: { disease: null } }),
            headers: new Headers({ 'content-type': 'application/json' }),
          });
        }

        return Promise.resolve(otAssociatedTargetsReply(otRows, { id: 'EFO_0000616', name: 'melanoma' }));
      }
      return Promise.reject(new Error(`unexpected url ${url.href}`));
    }) as any;

    installFakeTimers();
    try {
      const result = await advanceUntilSettled(diseaseGet('DOID:9999', ['gene_associations']));

      const associations = result.sections!.gene_associations as any[];
      expect(associations).toHaveLength(1);
      expect(associations[0].gene_symbol).toBe('TP53');
      expect(associations[0].source).toBe('opentargets');
      // Call 1: direct efoId probe (DOID_9999, colon→underscore); call 2: name
      // search; call 3: associatedTargets on the search-resolved id.
      expect(otBodies).toHaveLength(3);
      expect(otBodies[0].variables).toEqual({ efoId: 'DOID_9999' });
      expect(otBodies[1].variables).toEqual({ name: 'rare melanocytic neoplasm' });
      expect(otBodies[2].variables).toEqual({ efoId: 'EFO_0000616' });
    } finally {
      jest.useRealTimers();
      connectionManager.closeAll();
    }
  });
});

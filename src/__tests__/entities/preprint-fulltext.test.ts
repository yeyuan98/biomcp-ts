import { jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionManager } from '../../connections/manager.js';
import { parseMockUrl, mockFetchRouter } from '../helpers/mock-url.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';
import {
  fetchPreprintFullText,
  resetPreprintDownloadGate,
} from '../../entities/article/detail/preprint-fulltext.js';

// Small biorxiv-style JATS document: sections (incl. <sup> inline and a
// list block) + a back ref-list (hasReferences). Served by the download
// route to exercise the shared host-agnostic parser end-to-end.
const JATS_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<article article-type="research-article">
  <front><article-meta><article-title>Fixture preprint</article-title></article-meta></front>
  <body>
    <sec id="s1"><title>Introduction</title><p>We study H<sup>+</sup> transport in cells.</p></sec>
    <sec id="s2"><title>Methods</title><p>Reagents were prepared.</p><list><list-item><p>step one</p></list-item><list-item><p>step two</p></list-item></list></sec>
  </body>
  <back><ref-list><ref>1</ref></ref-list></back>
</article>`;

const DOI = '10.1101/2025.03.05.641768';
const JATS_URL = (v: number | string) => `https://www.biorxiv.org/content/${DOI}v${v}.source.xml`;

describe('preprint-fulltext', () => {
  mockGlobalFetch();
  let savedCacheDir: string | undefined;
  let cacheRoot: string;

  beforeEach(() => {
    savedCacheDir = process.env.BIOMCP_CACHE_DIR;
    cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-ppft-'));
    process.env.BIOMCP_CACHE_DIR = cacheRoot;
    connectionManager.closeAll();
    resetPreprintDownloadGate();
  });

  afterEach(() => {
    if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
    else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  const jsonResponse = (body: unknown) => ({
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  });
  const xmlResponse = (body: string, status = 200, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/xml', ...headers }),
    text: () => Promise.resolve(body),
  });

  const detailsPayload = (server = 'bioRxiv', versions: string[] = ['1', '2'], overrides: Record<string, unknown> = {}) => ({
    messages: [{ status: 'ok' }],
    collection: versions.map(v => ({
      doi: DOI,
      title: 'Rationality self-organizes beyond subjective reasonings',
      authors: 'Yonekura, S.; Kanazawa, H.',
      date: '2025-03-05',
      version: v,
      license: 'cc_by',
      category: 'neuroscience',
      jatsxml: JATS_URL(v),
      abstract: 'Abstract…',
      published: 'NA',
      server,
      ...overrides,
    })),
  });

  const fetchCallsTo = (host: string): number =>
    (global.fetch as any).mock.calls.filter((c: any[]) => parseMockUrl(c[0]).hostname === host).length;

  /** Standard router: api.biorxiv.org /details (biorxiv hit) + a controllable
   * www.biorxiv.org download route. */
  const standardRouter = (opts: {
    details?: unknown;
    biorxivDetails?: unknown;
    medrxivDetails?: unknown;
    jats?: (url: URL) => unknown;
  } = {}) =>
    mockFetchRouter([
      {
        host: 'api.biorxiv.org',
        path: '/details/',
        reply: (url: URL) => {
          if (url.pathname.startsWith('/details/medrxiv/')) {
            return Promise.resolve(jsonResponse(opts.medrxivDetails ?? { messages: [{ status: 'no posts found' }], collection: [] }));
          }
          return Promise.resolve(jsonResponse(opts.biorxivDetails ?? detailsPayload()));
        },
      },
      { host: 'www.biorxiv.org', reply: (url: URL) => opts.jats ? opts.jats(url) : Promise.resolve(xmlResponse(JATS_DOC)) },
    ]);

  test('rejects non-preprint DOIs up front', async () => {
    await expect(fetchPreprintFullText('10.1038/s41586-021-03819-2')).rejects.toThrow(/not a bioRxiv\/medRxiv preprint DOI/);
    await expect(fetchPreprintFullText(DOI, { version: 0 })).rejects.toThrow(/positive integer/);
  });

  test('downloads the latest version, normalizes the license, caches, returns a file handle', async () => {
    global.fetch = standardRouter() as any;

    const result = await fetchPreprintFullText(DOI);

    expect(result.status).toBe('available');
    expect(result.mode).toBe('file');
    expect(result.version).toBe(2); // latest of [1, 2]
    expect(result.server).toBe('bioRxiv');
    expect(result.license).toBe('cc by'); // cc_by → cc by
    expect(result.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(result.cached).toBe(false);
    expect(result.file_path && existsSync(result.file_path)).toBe(true);
    expect(result.outline?.map(o => o.heading)).toEqual(['Introduction', 'Methods']);
    // outline line numbers are exact for the written file
    const lines = readFileSync(result.file_path!, 'utf8').split('\n');
    for (const entry of result.outline ?? []) {
      expect(lines[entry.line - 1]).toBe(`## ${entry.heading}`);
    }
    // shared JATS parser semantics carried through: sub/sup parenthesized
    expect(readFileSync(result.file_path!, 'utf8')).toContain('H(+) transport in cells.');
    expect(readFileSync(result.file_path!, 'utf8')).toContain('version: 2');
    // references dropped with a pointer
    expect(result.note).toContain('reference list is omitted');
    expect(result.links).toMatchObject({ doi_url: `https://doi.org/${DOI}`, jatsxml_url: JATS_URL(2) });
  });

  test('second call is served from cache — no new download; pinned versions need no network at all', async () => {
    global.fetch = standardRouter() as any;

    await fetchPreprintFullText(DOI); // download
    expect(fetchCallsTo('www.biorxiv.org')).toBe(1);
    expect(fetchCallsTo('api.biorxiv.org')).toBe(1);

    const second = await fetchPreprintFullText(DOI); // default version → details + cache hit
    expect(fetchCallsTo('www.biorxiv.org')).toBe(1); // NO second download
    expect(second.cached).toBe(true);
    expect(second.status).toBe('available');

    const totalCalls = (global.fetch as any).mock.calls.length;
    const pinned = await fetchPreprintFullText(DOI, { version: 2 }); // cache-first: zero network
    expect((global.fetch as any).mock.calls.length).toBe(totalCalls);
    expect(pinned.cached).toBe(true);
    expect(pinned.version).toBe(2);
  }, 30000);

  test('inline mode applies the fulltext_max_chars budget honestly', async () => {
    const longBody = 'x'.repeat(5000);
    const bigDoc = JATS_DOC.replace('<p>We study H<sup>+</sup> transport in cells.</p>', `<p>${longBody}</p>`);
    global.fetch = standardRouter({ jats: () => Promise.resolve(xmlResponse(bigDoc)) }) as any;

    const result = await fetchPreprintFullText(DOI, { output: 'inline', maxChars: 1000 });

    expect(result.status).toBe('available');
    expect(result.mode).toBe('inline');
    expect(result.max_chars).toBe(1000);
    expect(result.sections?.length).toBeGreaterThan(0);
    // the shared applyCharBudget appends a single '…' to the cut section,
    // so the total may exceed the cap by exactly one char
    expect(result.char_count!).toBeLessThanOrEqual(result.max_chars + 1);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain('Truncated');
  });

  test('429/1015 verdict: rate_limited envelope, >=60s cooldown, next call is instant + network-free', async () => {
    global.fetch = standardRouter({ jats: () => Promise.resolve(xmlResponse('error code: 1015', 429)) }) as any;

    const first = await fetchPreprintFullText(DOI);
    expect(first).toMatchObject({ status: 'unavailable', reason: 'rate_limited' });
    expect(first.retry_after_sec!).toBeGreaterThanOrEqual(60);
    expect(first.links).toMatchObject({ jatsxml_url: JATS_URL(2), doi_url: `https://doi.org/${DOI}` });
    expect(first.note).toContain('rate-limiting');
    // the 429 verdict is final: exactly one download attempt, no retry
    expect(fetchCallsTo('www.biorxiv.org')).toBe(1);

    const callsAfterFirst = (global.fetch as any).mock.calls.length;
    const second = await fetchPreprintFullText(DOI);
    expect(second).toMatchObject({ status: 'unavailable', reason: 'rate_limited' });
    expect(second.retry_after_sec!).toBeGreaterThan(0);
    expect((global.fetch as any).mock.calls.length).toBe(callsAfterFirst); // zero network in cooldown
  });

  test('Retry-After (seconds form) is honored above the 60s floor', async () => {
    global.fetch = standardRouter({ jats: () => Promise.resolve(xmlResponse('error code: 1015', 429, { 'retry-after': '120' })) }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result.reason).toBe('rate_limited');
    expect(result.retry_after_sec!).toBeGreaterThanOrEqual(120);
  });

  test('403 is treated like 429 (Cloudflare block)', async () => {
    global.fetch = standardRouter({ jats: () => Promise.resolve(xmlResponse('Forbidden', 403)) }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'rate_limited' });
    expect(result.retry_after_sec!).toBeGreaterThanOrEqual(60);
  });

  test('a Cloudflare challenge page served with HTTP 200 is detected as rate limiting', async () => {
    global.fetch = standardRouter({ jats: () => Promise.resolve(xmlResponse('<html><body>Just a moment...</body></html>')) }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'rate_limited' });
  });

  test('challenge-phrase text deep in a legitimate JATS body is not misclassified', async () => {
    // 2KB of real XML prose before the phrase: the 1KB-prefix scan must miss it on purpose.
    const padding = '<sec id="pad"><title>Filler</title><p>' + 'lorem ipsum '.repeat(180) + '</p></sec>';
    const doc = JATS_DOC.replace('<sec id="s2">', `${padding}<sec id="s2"><p>As we waited, the page said: Just a moment...</p>`);
    global.fetch = standardRouter({ jats: () => Promise.resolve(xmlResponse(doc)) }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result.status).toBe('available');
    expect(result.reason).toBeUndefined();
  });

  test('during cooldown, the newest cached version is served with a disclosure', async () => {
    // v1 downloads fine; v2 trips the cooldown
    global.fetch = standardRouter({
      jats: (url: URL) => url.pathname.endsWith('v1.source.xml')
        ? Promise.resolve(xmlResponse(JATS_DOC))
        : Promise.resolve(xmlResponse('error code: 1015', 429)),
    }) as any;

    const v1 = await fetchPreprintFullText(DOI, { version: 1 });
    expect(v1.status).toBe('available');
    expect(v1.version).toBe(1);

    const blocked = await fetchPreprintFullText(DOI, { version: 2 });
    expect(blocked.reason).toBe('rate_limited');

    const served = await fetchPreprintFullText(DOI); // default version, cooldown active
    expect(served.status).toBe('available');
    expect(served.version).toBe(1); // newest cached
    expect(served.cached).toBe(true);
    expect(served.note).toContain('cooldown');
  });

  test('details resolution: falls through biorxiv → medrxiv and reports the server', async () => {
    global.fetch = standardRouter({
      biorxivDetails: { messages: [{ status: 'no posts found' }], collection: [] },
      medrxivDetails: detailsPayload('medRxiv', ['1']),
    }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result.status).toBe('available');
    expect(result.server).toBe('medRxiv');
    expect(result.version).toBe(1);
  });

  test('not_found when both collections soft-miss', async () => {
    global.fetch = standardRouter({ biorxivDetails: { messages: [{ status: 'no posts found' }], collection: [] } }) as any;
    const result = await fetchPreprintFullText('10.1101/2099.01.01.000001');
    expect(result).toMatchObject({ status: 'unavailable', reason: 'not_found' });
    expect(result.note).toContain('preprint_only');
  });

  test('not_found for an unknown explicit version, listing the available ones', async () => {
    global.fetch = standardRouter() as any;
    const result = await fetchPreprintFullText(DOI, { version: 99 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'not_found' });
    expect(result.note).toContain('[1, 2]');
  });

  test('no_jats_xml when the record carries no jatsxml URL', async () => {
    global.fetch = standardRouter({ biorxivDetails: detailsPayload('bioRxiv', ['1'], { jatsxml: undefined }) }) as any;
    const result = await fetchPreprintFullText(DOI, { version: 1 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'no_jats_xml' });
    expect(result.links?.jatsxml_url).toBeUndefined();
  });

  test('fetch_failed when api.biorxiv.org is unreachable', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('network down'))) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'fetch_failed' });
  }, 30000);

  test('fetch_failed after ONE bounded retry on download network errors, with cause + URL + remedy in the note', async () => {
    global.fetch = standardRouter({ jats: () => Promise.reject(new Error('connection reset')) }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'fetch_failed' });
    expect(fetchCallsTo('www.biorxiv.org')).toBe(2); // one retry, no more
    // #132: the failure detail must name the underlying cause AND the URL,
    // never degrade to "JATS download failed: " with an empty embed.
    expect(result.note).toContain('connection reset');
    expect(result.note).toContain(`from ${JATS_URL(2)}`);
    expect(result.note).toContain('Retry once; if it persists, use article_get (abstract) or the DOI landing page.');
  }, 30000);

  test('fetch_failed detail is never empty: empty-message rejection falls back to the error name', async () => {
    // An Error with an empty message previously produced a blank embed
    // ("JATS download failed: "). The fallback chain (message → cause →
    // name → String) must yield SOMETHING, plus the URL.
    global.fetch = standardRouter({ jats: () => Promise.reject(new Error('')) }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'fetch_failed' });
    expect(result.note).toContain('JATS download failed');
    expect(result.note).toContain(`from ${JATS_URL(2)}`);
    expect(result.note).not.toMatch(/failed \(\)/); // no empty cause embed
    expect(result.note).not.toContain('undefined');
    expect(result.note).toMatch(/\(Error\)/); // name fallback surfaced
  }, 30000);

  test('fetch_failed detail surfaces the cause code for raw fetch rejections', async () => {
    // Raw undici rejections are bare `TypeError: fetch failed` with the real
    // signal on cause.code — errorMessageWithCause appends it.
    const networkReject = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    global.fetch = standardRouter({ jats: () => Promise.reject(networkReject) }) as any;
    const result = await fetchPreprintFullText(DOI);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'fetch_failed' });
    expect(result.note).toContain('fetch failed (ECONNRESET)');
    expect(result.note).toContain(`from ${JATS_URL(2)}`);
  }, 30000);

  test('license "na" falls back verbatim with no URL and a reuse warning', async () => {
    global.fetch = standardRouter({ biorxivDetails: detailsPayload('bioRxiv', ['1'], { license: 'na' }) }) as any;
    const result = await fetchPreprintFullText(DOI, { version: 1 });
    expect(result.status).toBe('available');
    expect(result.license).toBe('na');
    expect(result.license_url).toBeUndefined();
    expect(result.note).toContain('reuse may be restricted');
  });

  test('underscore license forms normalize for the CC URL lookup (cc_by_nc_nd)', async () => {
    global.fetch = standardRouter({ biorxivDetails: detailsPayload('bioRxiv', ['1'], { license: 'cc_by_nc_nd' }) }) as any;
    const result = await fetchPreprintFullText(DOI, { version: 1 });
    expect(result.license).toBe('cc by-nc-nd');
    expect(result.license_url).toBe('https://creativecommons.org/licenses/by-nc-nd/4.0/');
  });
});

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { lookupJournalMetrics, clearJournalMetricsCache } from '../../entities/journal/index.js';
import { getJournalAbbreviationMap, resetJournalTitleMap } from '../../entities/article/search/journal-titles.js';
import { connectionManager } from '../../connections/manager.js';
import { parseMockUrl } from '../helpers/mock-url.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

/**
 * journal_metrics entity (OpenAlex /sources): query routing (ISSN vs name vs
 * NLM abbreviation), transform, zombie-source hygiene, error classification,
 * and the 24h response cache. Mirrors citation.test.ts: global.fetch mocks
 * through the REAL openalex connection (registry rate limiter + retry), so
 * every network test runs under fake timers and advanceUntilSettled steps
 * the virtual clock past the 1s token-bucket spacing and 429 backoffs.
 */

const ENV_VAR = 'BIOMCP_JOURNAL_TITLES_PATH';

function mockJson(data: unknown) {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

// Await a promise that internally sleeps on module timers (token-bucket rate
// limiters, registry retry backoffs) under jest fake timers, stepping the
// clock until the promise settles (pattern from citation.test.ts).
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
      throw new Error('promise never settled under fake timers — the flow under test is stuck');
    }
    await jest.advanceTimersByTimeAsync(250);
  }
  if (failure) throw failure.error;
  return value as T;
}

/** The exact select list pinned by the entity (every field it transforms). */
const SELECT_LIST =
  'id,display_name,alternate_titles,issn,issn_l,type,is_oa,is_in_doaj,is_core,homepage_url,works_count,cited_by_count,summary_stats,counts_by_year,listed_in';

/** Realistic OpenAlex /sources record (Nature). */
function natureSource() {
  // 12 year-rows, deliberately UNSORTED, spanning 2012–2023.
  const countsByYear = [
    { year: 2020, works_count: 15276, cited_by_count: 695977 },
    { year: 2023, works_count: 13372, cited_by_count: 818297 },
    { year: 2015, works_count: 14063, cited_by_count: 521178 },
    { year: 2018, works_count: 15179, cited_by_count: 660411 },
    { year: 2012, works_count: 12914, cited_by_count: 384613 },
    { year: 2022, works_count: 15442, cited_by_count: 783497 },
    { year: 2017, works_count: 15083, cited_by_count: 604680 },
    { year: 2014, works_count: 13891, cited_by_count: 484056 },
    { year: 2021, works_count: 15726, cited_by_count: 751381 },
    { year: 2016, works_count: 14516, cited_by_count: 558477 },
    { year: 2019, works_count: 15228, cited_by_count: 670881 },
    { year: 2013, works_count: 13459, cited_by_count: 439106 },
  ];
  return {
    id: 'https://openalex.org/S137773608',
    display_name: 'Nature',
    alternate_titles: [],
    issn: ['0028-0836', '1476-4687'],
    issn_l: '0028-0836',
    type: 'journal',
    is_oa: false,
    is_in_doaj: false,
    is_core: true,
    homepage_url: 'https://www.nature.com/nature',
    works_count: 651377,
    cited_by_count: 82500123,
    summary_stats: { '2yr_mean_citedness': 63.12345678, h_index: 1373, i10_index: 311528 },
    counts_by_year: countsByYear,
    listed_in: ['doaj', 'medline'],
  };
}

/** The URL of fetch call n (0-based), parsed for exact host/path/params. */
function fetchUrl(call = 0): URL {
  return parseMockUrl((global.fetch as any).mock.calls[call][0]);
}

describe('journal metrics entity (OpenAlex /sources)', () => {
  mockGlobalFetch();

  let dir: string;

  beforeEach(() => {
    jest.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'biomcp-journal-'));
    const tsv = [
      'nature\tNature',
      'new england journal of medicine\tN Engl J Med',
      'journal of nothing\t', // empty abbreviation: must be skipped by the inversion
    ].join('\n') + '\n';
    const asset = join(dir, 'journal-titles.tsv.gz');
    writeFileSync(asset, gzipSync(Buffer.from(tsv, 'utf8')));
    process.env[ENV_VAR] = asset;
    resetJournalTitleMap();
    clearJournalMetricsCache();
    connectionManager.closeAll();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env[ENV_VAR];
    resetJournalTitleMap();
    clearJournalMetricsCache();
    connectionManager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('abbreviation map (inverted NLM list)', () => {
    test('inverts title→abbr to normalized-abbr→title, skipping empty abbreviations', () => {
      const inverted = getJournalAbbreviationMap();
      expect(inverted.get('n engl j med')).toBe('new england journal of medicine');
      expect(inverted.get('nature')).toBe('nature'); // self-mapping
      expect(inverted.has('')).toBe(false); // 'journal of nothing' has an empty abbr
      expect(inverted.size).toBe(2);
    });
  });

  describe('ISSN route', () => {
    test('queries filter=issn with the exact select list and transforms the source', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ meta: { count: 1 }, results: [natureSource()] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('0028-0836'));

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const url = fetchUrl();
      expect(url.hostname).toBe('api.openalex.org');
      expect(url.pathname).toBe('/sources');
      expect(url.searchParams.get('filter')).toBe('issn:0028-0836');
      expect(url.searchParams.get('select')).toBe(SELECT_LIST);
      expect(url.searchParams.get('per-page')).toBeNull(); // limit is irrelevant on the exact route

      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.results).toHaveLength(1);
      const r = result.results[0];
      expect(r.openalex_id).toBe('S137773608'); // last path segment of the id URL
      expect(r.source).toBe('openalex');
      expect(r.display_name).toBe('Nature');
      expect(r.issn).toEqual(['0028-0836', '1476-4687']);
      expect(r.issn_l).toBe('0028-0836');
      expect(r.type).toBe('journal');
      expect(r.is_oa).toBe(false);
      expect(r.is_in_doaj).toBe(false);
      expect(r.is_core).toBe(true);
      expect(r.alternate_titles).toEqual([]);
      expect(r.listed_in).toEqual(['doaj', 'medline']);
      expect(r.summary_stats).toEqual({
        two_year_mean_citedness: 63.12345678,
        h_index: 1373,
        i10_index: 311528,
      });
      // counts_by_year: sorted year DESC and trimmed to 10 of the 12 unsorted rows
      expect(r.counts_by_year).toHaveLength(10);
      expect(r.counts_by_year!.map((c) => c.year)).toEqual([
        2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014,
      ]);
      expect(r.counts_by_year![0]).toEqual({ year: 2023, works_count: 13372, cited_by_count: 818297 });
    });

    test('uppercases a lowercase-x ISSN before the filter', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [] })
      ) as any;

      await advanceUntilSettled(lookupJournalMetrics('1234-567x'));

      expect(fetchUrl().searchParams.get('filter')).toBe('issn:1234-567X');
    });
  });

  describe('name route', () => {
    test('NLM abbreviation expands to the full title with a disclosure warning', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [natureSource()] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('N Engl J Med'));

      const url = fetchUrl();
      expect(url.searchParams.get('search')).toBe('new england journal of medicine');
      expect(url.searchParams.get('per-page')).toBe('5'); // default limit
      expect(url.searchParams.get('select')).toBe(SELECT_LIST);
      expect(result.warnings).toContain(
        "Journal abbreviation expanded: 'N Engl J Med' → 'new england journal of medicine' (NLM)."
      );
      expect(result.results).toHaveLength(1);
    });

    test('self-mapped abbreviation (nature→nature) searches without an expansion warning', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [natureSource()] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('Nature'));

      expect(fetchUrl().searchParams.get('search')).toBe('nature');
      expect(result.warnings.some((w) => w.includes('abbreviation expanded'))).toBe(false);
    });

    test('unknown name searches the normalized phrase with no expansion', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('Journal of Made Up Things', { limit: 3 }));

      const url = fetchUrl();
      expect(url.searchParams.get('search')).toBe('journal of made up things');
      expect(url.searchParams.get('per-page')).toBe('3');
      expect(result.warnings.some((w) => w.includes('abbreviation expanded'))).toBe(false);
    });

    test('zero hits returns empty results with the zero-match warning', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ meta: { count: 0 }, results: [] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('Journal of Made Up Things'));

      expect(result.results).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toContain('No journal matched — try the exact journal title or its ISSN.');
    });
  });

  describe('zombie-source hygiene', () => {
    test('duplicate display_name keeps the best 2yr-mean-citedness record and discloses the suppressed id', async () => {
      const zombie = {
        id: 'https://openalex.org/S000000001',
        display_name: 'BMJ',
        issn: ['0959-535X'],
        works_count: 50000,
        summary_stats: { '2yr_mean_citedness': 0.0, h_index: 100, i10_index: 5000 },
      };
      const live = {
        id: 'https://openalex.org/S000000002',
        display_name: 'BMJ',
        issn: ['0959-535X', '1756-1833'],
        works_count: 1000,
        summary_stats: { '2yr_mean_citedness': 4.88, h_index: 200, i10_index: 2000 },
      };
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [zombie, live] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('BMJ'));

      expect(result.results).toHaveLength(1);
      expect(result.results[0].openalex_id).toBe('S000000002');
      expect(result.results[0].summary_stats!.two_year_mean_citedness).toBe(4.88);
      expect(result.warnings).toContain(
        "Duplicate OpenAlex records for 'BMJ'; showing S000000002 (suppressed: S000000001)."
      );
    });
  });

  describe('transform tolerance', () => {
    test('missing summary_stats becomes null', async () => {
      const bare = {
        id: 'https://openalex.org/S999999999',
        display_name: 'Journal of Tolerance',
      };
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [bare] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('Journal of Tolerance'));

      expect(result.results[0].openalex_id).toBe('S999999999');
      expect(result.results[0].summary_stats).toBeNull();
      expect(result.results[0].alternate_titles).toBeUndefined();
      expect(result.results[0].counts_by_year).toBeUndefined();
    });
  });

  describe('error classification', () => {
    test('a daily-budget 429 maps to a non-retryable error advertising OPENALEX_API_KEY', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: () => Promise.resolve(
          JSON.stringify({ error: 'Daily budget of USD $0.10 exhausted for this IP. Please slow down or obtain a private budget.' })
        ),
      }) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('Nature'));

      expect(result.results).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].source).toBe('openalex');
      expect(result.errors[0].retryable).toBe(false);
      expect(result.errors[0].message).toContain('OPENALEX_API_KEY');
      expect(result.errors[0].message).toContain('daily budget exhausted');
      expect(result.errors[0].message).toContain('midnight UTC');
      // registry retry policy (attempts 3) exhausted the retryable 429 first
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('a plain per-second 429 maps to a retryable throttle error', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: () => Promise.resolve('Too many requests, per-second rate limit exceeded'),
      }) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('Nature'));

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].retryable).toBe(true);
      expect(result.errors[0].message).toContain('per-second');
      expect(result.errors[0].message).toContain('retry shortly');
    });
  });

  describe('24h response cache', () => {
    test('identical lookups do not re-fetch; clearJournalMetricsCache forces a refetch', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [natureSource()] })
      ) as any;

      const first = await advanceUntilSettled(lookupJournalMetrics('Nature'));
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const second = await advanceUntilSettled(lookupJournalMetrics('Nature'));
      expect(global.fetch).toHaveBeenCalledTimes(1); // served from cache
      expect(second).toEqual(first);

      clearJournalMetricsCache();
      await advanceUntilSettled(lookupJournalMetrics('Nature'));
      expect(global.fetch).toHaveBeenCalledTimes(2); // forced refetch
    });

    test('a different limit is a different cache key (per-page rides the request path)', async () => {
      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [natureSource()] })
      ) as any;

      await advanceUntilSettled(lookupJournalMetrics('Nature'));
      await advanceUntilSettled(lookupJournalMetrics('Nature', { limit: 10 }));

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(fetchUrl(1).searchParams.get('per-page')).toBe('10');
    });
  });

  describe('reset interaction', () => {
    test('resetJournalTitleMap clears the inverted map: expansion stops after a reset to a missing asset', async () => {
      process.env[ENV_VAR] = join(dir, 'does-not-exist.tsv.gz');
      resetJournalTitleMap();
      expect(getJournalAbbreviationMap().size).toBe(0);

      global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue(
        mockJson({ results: [] })
      ) as any;

      const result = await advanceUntilSettled(lookupJournalMetrics('N Engl J Med'));

      expect(fetchUrl().searchParams.get('search')).toBe('n engl j med');
      expect(result.warnings.some((w) => w.includes('abbreviation expanded'))).toBe(false);
    });
  });
});

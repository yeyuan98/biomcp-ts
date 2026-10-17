import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Live, ONE attempt per run (politeness to www.biorxiv.org — issue #44): the
// sandbox/CI either gets the JATS (available) or Cloudflare's 429/1015
// (graceful rate_limited envelope with retry_after_sec). Both are passes; a
// crash/timeout is the only failure. Environment-unreachable (api.biorxiv.org
// transport failure → fetch_failed) is a skip-with-note, not a failure.

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;
let savedCacheDir: string | undefined;
let cacheRoot: string;

beforeAll(async () => {
  harness = await createMcpTestHarness();
  // Keep any live file output off the real ~/.cache/biomcp.
  savedCacheDir = process.env.BIOMCP_CACHE_DIR;
  cacheRoot = mkdtempSync(join(tmpdir(), 'biomcp-ppftint-'));
  process.env.BIOMCP_CACHE_DIR = cacheRoot;
}, 30000);

afterAll(async () => {
  await harness.close();
  if (savedCacheDir === undefined) delete process.env.BIOMCP_CACHE_DIR;
  else process.env.BIOMCP_CACHE_DIR = savedCacheDir;
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe('preprint_fulltext (live, one attempt)', () => {
  it('returns available full text OR a graceful rate_limited envelope', async () => {
    const result = await harness.callTool('preprint_fulltext', {
      id: '10.1101/2021.10.25.465764',
      output: 'inline',
      fulltext_max_chars: 2000,
    }, { timeoutMs: 125_000 });

    expect(['available', 'unavailable']).toContain(result.status);
    expect(typeof result.note).toBe('string');

    if (result.status === 'available') {
      expect(result.doi).toBe('10.1101/2021.10.25.465764');
      expect(result.version).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(result.sections)).toBe(true);
      expect(result.sections.length).toBeGreaterThan(0);
      expect(typeof result.sections[0].text).toBe('string');
      expect(result.char_count).toBeGreaterThan(0);
      expect(typeof result.license).toBe('string');
    } else if (result.reason === 'rate_limited') {
      expect(result.retry_after_sec).toBeGreaterThanOrEqual(60);
      expect(result.links?.doi_url).toContain('https://doi.org/');
    } else if (result.reason === 'fetch_failed') {
      // Environment cannot reach the hosts — skip-with-note per mission.
      console.warn('[preprint_fulltext live] hosts unreachable, treating as skip:', result.note);
      return;
    } else {
      // not_found / no_jats_xml for a DOI known to exist would be a bug.
      throw new Error(`unexpected unavailable reason for a known preprint: ${result.reason} — ${result.note}`);
    }
  }, 125_000);
});

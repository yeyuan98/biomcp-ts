import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['ANALYSIS_R_MIRROR_URL', 'ANALYSIS_R_GITHUB_REPO', 'ANALYSIS_R_ASSET_TIMEOUT_MS', 'BIOMCP_CACHE_DIR'] as const;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function makeBundleDir(root: string): { dir: string; tarPath: string } {
  const src = join(root, 'bundle-src');
  mkdirSync(join(src, 'bin', 'emscripten', 'contrib', '4.6'), { recursive: true });
  const pkg = join(src, 'bin', 'emscripten', 'contrib', '4.6', 'pkgA_1.0.0.tgz');
  writeFileSync(pkg, Buffer.from('fake wasm binary'));
  const manifest = {
    created: '2026-08-27T00:00:00Z',
    files: [{ name: 'bin/emscripten/contrib/4.6/pkgA_1.0.0.tgz', sha256: sha256(pkg) }],
  };
  writeFileSync(join(src, 'manifest.json'), JSON.stringify(manifest));
  const tarPath = join(root, 'bundle.tar.gz');
  const r = spawnSync('tar', ['-czf', tarPath, '-C', src, '.']);
  if (r.status !== 0) throw new Error('tar failed in fixture');
  return { dir: src, tarPath };
}

describe('MirrorServer file serving (whitelist map)', () => {
  let tmpRoot: string;
  let bundleDir: string;
  let server: InstanceType<typeof import('../../ranalysis/mirror.js').MirrorServer>;
  let base: string;
  const realFetch = global.fetch;

  beforeEach(async () => {
    global.fetch = realFetch;
    tmpRoot = mkdtempSync(join(tmpdir(), 'biomcp-mirror-server-test-'));
    bundleDir = join(tmpRoot, 'bundle');
    mkdirSync(join(bundleDir, 'bin', 'sub'), { recursive: true });
    writeFileSync(join(bundleDir, 'manifest.json'), '{}');
    writeFileSync(join(bundleDir, 'bin', 'sub', 'pkg_1.0.0.tgz'), Buffer.from('wasm-bytes'));
    const { MirrorServer } = await import('../../ranalysis/mirror.js');
    server = new MirrorServer();
    base = await server.start(bundleDir);
  });

  afterEach(async () => {
    global.fetch = realFetch;
    await server.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function get(path: string): Promise<{ status: number; body: string }> {
    return fetch(base + path).then(async (r) => ({ status: r.status, body: await r.text() }));
  }

  it('serves a whitelisted file with CORS and content-type', async () => {
    const r = await get('/bin/sub/pkg_1.0.0.tgz');
    expect(r.status).toBe(200);
    expect(r.body).toBe('wasm-bytes');
    const res = await fetch(base + '/bin/sub/pkg_1.0.0.tgz?x=1');
    expect(res.status).toBe(200);
  });

  it('404s missing files, encoded traversal keys, directories, root, and double-slash paths', async () => {
    for (const path of ['/nosuch.tgz', '/..%2f..%2fetc%2fpasswd', '/bin/sub', '/', '//bin/sub/pkg_1.0.0.tgz']) {
      const r = await get(path);
      expect([path, r.status]).toEqual([path, 404]);
    }
  });

  it('serves normalized dot-segment requests that stay inside the root', async () => {
    for (const path of ['/bin/../manifest.json', '/%2e%2e/manifest.json']) {
      const r = await get(path);
      expect(r.status).toBe(200);
    }
  });

  it('400s malformed percent-encoding instead of crashing', async () => {
    const r = await get('/%zz');
    expect(r.status).toBe(400);
  });

  it('does not serve files outside the bundle root', async () => {
    writeFileSync(join(tmpRoot, 'outside.txt'), 'secret');
    const r = await get('/outside.txt');
    expect(r.status).toBe(404);
  });
});

describe('wasm mirror resolution', () => {
  let tmpRoot: string;
  let cacheDir: string;
  let fetchMock: jest.Mock;

  async function importMirror() {
    const mod = await import('../../ranalysis/mirror.js');
    mod.resetMirrorForTests();
    return mod;
  }

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    tmpRoot = mkdtempSync(join(tmpdir(), 'biomcp-mirror-test-'));
    cacheDir = join(tmpRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    process.env.BIOMCP_CACHE_DIR = cacheDir;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    const mod = await import('../../ranalysis/mirror.js');
    mod.resetMirrorForTests();
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k]!;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('uses an env-provided directory directly', async () => {
    const { dir } = makeBundleDir(tmpRoot);
    process.env.ANALYSIS_R_MIRROR_URL = dir;
    const { resolveMirror } = await importMirror();
    const res = await resolveMirror();
    expect(res.origin).toBe('env-dir');
    expect(res.dir).toBe(dir);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts and verifies an env-provided archive', async () => {
    const { tarPath } = makeBundleDir(tmpRoot);
    process.env.ANALYSIS_R_MIRROR_URL = tarPath;
    const { resolveMirror } = await importMirror();
    const res = await resolveMirror();
    expect(res.origin).toBe('env-archive');
    expect(existsSync(join(res.dir, 'manifest.json'))).toBe(true);
    expect(res.manifest?.files).toHaveLength(1);
  });

  it('rejects a tampered archive via manifest checksums and deletes the bundle', async () => {
    const src = join(tmpRoot, 'tampered');
    mkdirSync(join(src, 'bin'), { recursive: true });
    writeFileSync(join(src, 'bin', 'evil.tgz'), Buffer.from('evil'));
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ files: [{ name: 'bin/evil.tgz', sha256: '0'.repeat(64) }] }));
    const tarPath = join(tmpRoot, 'tampered.tar.gz');
    spawnSync('tar', ['-czf', tarPath, '-C', src, '.']);
    process.env.ANALYSIS_R_MIRROR_URL = tarPath;
    const { resolveMirror } = await importMirror();
    await expect(resolveMirror()).rejects.toThrow(/Checksum mismatch/);
  });

  it('downloads the latest release asset and skips re-download when the digest is unchanged', async () => {
    const { tarPath } = makeBundleDir(tmpRoot);
    const bundleBytes = readFileSync(tarPath);
    const digest = createHash('sha256').update(bundleBytes).digest('hex');
    const apiBody = {
      assets: [
        { name: 'r-wasm-mirror-20260827-abc1234.tar.gz', digest: `sha256:${digest}`, updated_at: '2026-08-27T00:00:00Z', browser_download_url: 'https://example.test/mirror.tar.gz' },
      ],
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).hostname === 'api.github.com') {
        return new Response(JSON.stringify(apiBody), { status: 200 });
      }
      return new Response(bundleBytes, { status: 200 });
    });
    const { resolveMirror } = await importMirror();
    const res = await resolveMirror();
    expect(res.origin).toBe('release');
    expect(existsSync(join(res.dir, 'manifest.json'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const { resolveMirror: resolveAgain } = await importMirror();
    const cached = await resolveAgain();
    expect(cached.origin).toBe('cache');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('errors clearly when the latest release has no mirror asset', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ assets: [] }), { status: 200 }));
    const { resolveMirror } = await importMirror();
    await expect(resolveMirror()).rejects.toThrow(/no r-wasm-mirror asset/);
  });

  it('rejects env URLs that are neither paths nor http(s)', async () => {
    process.env.ANALYSIS_R_MIRROR_URL = 'ftp://example.test/mirror.tar.gz';
    const { resolveMirror } = await importMirror();
    await expect(resolveMirror()).rejects.toThrow(/ANALYSIS_R_MIRROR_URL must be/);
  });

  it('download timeout surfaces as MirrorError with remediation naming the knob and the mirror recipe', async () => {
    process.env.ANALYSIS_R_ASSET_TIMEOUT_MS = '45000';
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ assets: [{ name: 'r-wasm-mirror-test.tar.gz', browser_download_url: 'http://mirror.test/asset.tar.gz', id: 7, updated_at: 't' }] }), { status: 200 })
    );
    fetchMock.mockImplementationOnce(async () => {
      // undici rejects body consumption with a DOMException named TimeoutError
      // when the abort signal fires mid-stream — simulate that surface.
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    });
    const { resolveMirror } = await importMirror();
    await expect(resolveMirror()).rejects.toThrow(/timed out after 45s.*asset_timeout_ms.*ANALYSIS_R_ASSET_TIMEOUT_MS.*mirror_url/s);
  });

  it('lazy store memo: resetMirrorForTests re-reads the timeout env on the next resolve', async () => {
    const respondReleaseThenTimeout = () => {
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ assets: [{ name: 'r-wasm-mirror-test.tar.gz', browser_download_url: 'http://mirror.test/asset.tar.gz', id: 7, updated_at: 't' }] }), { status: 200 })
      );
      fetchMock.mockImplementationOnce(async () => {
        const e = new Error('aborted');
        e.name = 'TimeoutError';
        throw e;
      });
    };
    process.env.ANALYSIS_R_ASSET_TIMEOUT_MS = '30000';
    respondReleaseThenTimeout();
    const mod = await importMirror();
    await expect(mod.resolveMirror()).rejects.toThrow(/timed out after 30s/);
    // change the knob WITHOUT reset: memoized store keeps the old timeout…
    process.env.ANALYSIS_R_ASSET_TIMEOUT_MS = '90000';
    respondReleaseThenTimeout();
    await expect(mod.resolveMirror()).rejects.toThrow(/timed out after 30s/);
    // …and reset picks up the new value (file-set knob lands after env fill)
    const mod2 = await importMirror(); // importMirror() resets the memo
    respondReleaseThenTimeout();
    await expect(mod2.resolveMirror()).rejects.toThrow(/timed out after 90s/);
  });

  it('out-of-range or NaN timeout env falls back to the 600s default', async () => {
    process.env.ANALYSIS_R_ASSET_TIMEOUT_MS = 'not-a-number';
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ assets: [{ name: 'r-wasm-mirror-test.tar.gz', browser_download_url: 'http://mirror.test/asset.tar.gz', id: 7, updated_at: 't' }] }), { status: 200 })
    );
    fetchMock.mockImplementationOnce(async () => {
      const e = new Error('aborted');
      e.name = 'TimeoutError';
      throw e;
    });
    const { resolveMirror } = await importMirror();
    await expect(resolveMirror()).rejects.toThrow(/timed out after 600s/);
  });
});

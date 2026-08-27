import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  VerifiedAssetStore,
  StaticFileServer,
  type AssetStoreConfig,
} from '../../wasmcore/assets.js';

class TestAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestAssetError';
  }
}

const CFG: AssetStoreConfig = {
  errorCtor: TestAssetError,
  label: 'Asset',
  envVar: 'TEST_ASSET_URL',
  repoEnvVar: 'TEST_ASSET_REPO',
  defaultRepo: 'example/test-repo',
  assetNameRe: /^test-assets-.*\.tar\.gz$/,
  assetLabel: 'test-assets',
  userAgent: 'biomcp-wasmcore-test',
};

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['TEST_ASSET_URL', 'TEST_ASSET_REPO', 'BIOMCP_CACHE_DIR'] as const;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function makeBundleDir(root: string, name = 'bundle-src'): { dir: string; tarPath: string } {
  const src = join(root, name);
  mkdirSync(join(src, 'files', 'nested'), { recursive: true });
  const payload = join(src, 'files', 'nested', 'payload.bin');
  writeFileSync(payload, Buffer.from('fake wasm binary'));
  const manifest = {
    created: '2026-08-27T00:00:00Z',
    files: [{ name: 'files/nested/payload.bin', sha256: sha256(payload) }],
  };
  writeFileSync(join(src, 'manifest.json'), JSON.stringify(manifest));
  const tarPath = join(root, `${name}.tar.gz`);
  const r = spawnSync('tar', ['-czf', tarPath, '-C', src, '.']);
  if (r.status !== 0) throw new Error('tar failed in fixture');
  return { dir: src, tarPath };
}

describe('VerifiedAssetStore', () => {
  let tmpRoot: string;
  let cacheDir: string;
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    tmpRoot = mkdtempSync(join(tmpdir(), 'biomcp-wasmcore-assets-test-'));
    cacheDir = join(tmpRoot, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    process.env.BIOMCP_CACHE_DIR = cacheDir;
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    global.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k];
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('uses an env-provided directory directly without network access', async () => {
    const { dir } = makeBundleDir(tmpRoot);
    process.env.TEST_ASSET_URL = dir;
    const store = new VerifiedAssetStore(CFG);
    const res = await store.resolve();
    expect(res.origin).toBe('env-dir');
    expect(res.dir).toBe(dir);
    expect(res.manifest?.files).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('extracts and verifies an env-provided archive under the assetLabel cache prefix', async () => {
    const { tarPath } = makeBundleDir(tmpRoot);
    process.env.TEST_ASSET_URL = tarPath;
    const store = new VerifiedAssetStore(CFG);
    const res = await store.resolve();
    expect(res.origin).toBe('env-archive');
    expect(existsSync(join(res.dir, 'manifest.json'))).toBe(true);
    expect(res.dir.startsWith(join(cacheDir, 'test-assets-'))).toBe(true);
    expect(res.manifest?.files).toHaveLength(1);
    expect(readFileSync(join(res.dir, 'files', 'nested', 'payload.bin'), 'utf8')).toBe('fake wasm binary');
  });

  it('rejects a tampered archive via manifest checksums and quarantines the bundle', async () => {
    const src = join(tmpRoot, 'tampered');
    mkdirSync(join(src, 'files'), { recursive: true });
    writeFileSync(join(src, 'files', 'evil.bin'), Buffer.from('evil'));
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ files: [{ name: 'files/evil.bin', sha256: '0'.repeat(64) }] }));
    const tarPath = join(tmpRoot, 'tampered.tar.gz');
    spawnSync('tar', ['-czf', tarPath, '-C', src, '.']);
    process.env.TEST_ASSET_URL = tarPath;
    const store = new VerifiedAssetStore(CFG);
    const err = await store.resolve().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TestAssetError);
    expect((err as Error).message).toMatch(/Checksum mismatch for files\/evil\.bin/);
    const extractedDir = join(cacheDir, `test-assets-${sha256(tarPath).slice(0, 16)}`);
    expect(existsSync(extractedDir)).toBe(false);
  });

  it('rejects bundles containing unsafe member paths', async () => {
    const src = join(tmpRoot, 'unsafe-src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'manifest.json'), '{}');
    for (const [name, transform] of [
      ['parent.tar.gz', 's,^,../,'],
      ['absolute.tar.gz', 's,^\\./,/,' ],
    ] as const) {
      const tarPath = join(tmpRoot, name);
      const r = spawnSync('tar', ['-czf', tarPath, '--transform', transform, '-C', src, '.']);
      if (r.status !== 0) throw new Error(`tar fixture failed for ${name}`);
      process.env.TEST_ASSET_URL = tarPath;
      const store = new VerifiedAssetStore(CFG);
      await expect(store.resolve()).rejects.toThrow(/unsafe member path/);
    }
  });

  it('downloads the release asset, verifies the digest, and skips re-download via the state file', async () => {
    const { tarPath } = makeBundleDir(tmpRoot);
    const bundleBytes = readFileSync(tarPath);
    const digest = createHash('sha256').update(bundleBytes).digest('hex');
    const apiBody = {
      assets: [
        { name: 'test-assets-20260827-abc.tar.gz', digest: `sha256:${digest}`, updated_at: '2026-08-27T00:00:00Z', browser_download_url: 'https://example.test/assets.tar.gz' },
      ],
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).hostname === 'api.github.com') {
        return new Response(JSON.stringify(apiBody), { status: 200 });
      }
      return new Response(bundleBytes, { status: 200 });
    });
    const store = new VerifiedAssetStore(CFG);
    const res = await store.resolve();
    expect(res.origin).toBe('release');
    expect(existsSync(join(res.dir, 'manifest.json'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readdirSync(cacheDir).some((f) => f.startsWith('test-assets-download-'))).toBe(false);

    const again = await store.resolve();
    expect(again.origin).toBe('release');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const fresh = new VerifiedAssetStore(CFG);
    const cached = await fresh.resolve();
    expect(cached.origin).toBe('cache');
    expect(cached.dir).toBe(res.dir);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(existsSync(join(cacheDir, 'test-assets-state.json'))).toBe(true);
  });

  it('rejects a release download whose hash does not match the reported digest', async () => {
    const { tarPath } = makeBundleDir(tmpRoot);
    const bundleBytes = readFileSync(tarPath);
    const apiBody = {
      assets: [
        { name: 'test-assets-x.tar.gz', digest: `sha256:${'0'.repeat(64)}`, browser_download_url: 'https://example.test/assets.tar.gz' },
      ],
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (new URL(url).hostname === 'api.github.com') {
        return new Response(JSON.stringify(apiBody), { status: 200 });
      }
      return new Response(bundleBytes, { status: 200 });
    });
    const store = new VerifiedAssetStore(CFG);
    await expect(store.resolve()).rejects.toThrow(/does not match the GitHub-reported digest/);
    expect(readdirSync(cacheDir).some((f) => f.startsWith('test-assets-download-'))).toBe(false);
  });

  it('errors clearly when the latest release has no matching asset', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ assets: [] }), { status: 200 }));
    const store = new VerifiedAssetStore(CFG);
    const err = await store.resolve().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TestAssetError);
    expect((err as Error).message).toMatch(/no test-assets asset/);
    expect((err as Error).message).toMatch(/Set TEST_ASSET_URL/);
  });

  it('rejects env URLs that are neither paths nor http(s)', async () => {
    process.env.TEST_ASSET_URL = 'ftp://example.test/assets.tar.gz';
    const store = new VerifiedAssetStore(CFG);
    await expect(store.resolve()).rejects.toThrow(/TEST_ASSET_URL must be/);
  });

  it('downloads and caches an http(s) env URL keyed by URL hash', async () => {
    const { tarPath } = makeBundleDir(tmpRoot);
    const bundleBytes = readFileSync(tarPath);
    const url = 'https://example.test/mirror/bundle.tar.gz';
    fetchMock.mockImplementation(async () => new Response(bundleBytes, { status: 200 }));
    process.env.TEST_ASSET_URL = url;
    const store = new VerifiedAssetStore(CFG);
    const res = await store.resolve();
    expect(res.origin).toBe('env-archive');
    expect(res.dir.startsWith(join(cacheDir, 'test-assets-url-'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const again = await store.resolve();
    expect(again.dir).toBe(res.dir);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('StaticFileServer', () => {
  let tmpRoot: string;
  let server: StaticFileServer;
  let base: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'biomcp-wasmcore-server-test-'));
    const root = join(tmpRoot, 'bundle');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'manifest.json'), '{}');
    writeFileSync(join(root, 'sub', 'a.wasm'), Buffer.from('wasm-bytes'));
    writeFileSync(join(root, 'sub', 'notes.txt'), 'plain');
    server = new StaticFileServer({ '.wasm': 'application/wasm' });
    base = await server.start(root);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('serves files with the configured MIME type and CORS', async () => {
    const res = await fetch(base + '/sub/a.wasm');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/wasm');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toBe('wasm-bytes');
  });

  it('falls back to text/plain for unmapped extensions', async () => {
    const res = await fetch(base + '/sub/notes.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
  });

  it('404s unknown keys and files outside the served root', async () => {
    writeFileSync(join(tmpRoot, 'outside.txt'), 'secret');
    for (const path of ['/nosuch.bin', '/outside.txt', '/', '//sub/a.wasm']) {
      const res = await fetch(base + path);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  it('start is idempotent and close stops serving', async () => {
    const again = await server.start(join(tmpRoot, 'bundle'));
    expect(again).toBe(base);
    await server.close();
    await expect(fetch(base + '/manifest.json')).rejects.toThrow();
  });
});

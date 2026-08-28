import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BIOWASM_TOOLS,
  PINNED_SHA256,
  biowasmCacheStatePath,
  biowasmCacheDirPath,
  cdnFileUrl,
  expectedAssetFileNames,
  parseRemotePackageSize,
  provisionBiowasmAssets,
  validateDataSize,
  validateJsGlueContent,
  validateWasmBuffer,
} from '../../biowasm/registry.js';

const EMPTY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const GLUE = (size: number) =>
  Buffer.from(`var Module=function(Module){Module["loadPackage"]=1;return Module};var metadata=({files:[],"remote_package_size":${size},"package_uuid":"x"})();`);

interface FakeResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function fakeResponse(buf: Buffer, ok = true): FakeResponse {
  return {
    ok,
    status: ok ? 200 : 500,
    arrayBuffer: async () => {
      if (!ok) throw new Error('http error');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  };
}

function makeAssetSet(jsSize = 100): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const perToolData: Record<string, number> = {};
  for (const tool of Object.keys(BIOWASM_TOOLS) as Array<keyof typeof BIOWASM_TOOLS>) {
    const glue = GLUE(perToolData[tool] ?? jsSize);
    perToolData[`${tool}.js`] = glue.length;
    files.set(`${tool}.js`, glue);
    files.set(`${tool}.wasm`, EMPTY_WASM);
    files.set(`${tool}.data`, Buffer.alloc(jsSize, 7));
  }
  return files;
}

/** Serve the given buffers with the given sha256 values (pins are for real CDN builds, so tests fake the pins). */
function pinsFor(files: Map<string, Buffer>): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const [name, buf] of files) pins[name] = createHash('sha256').update(buf).digest('hex');
  return pins;
}

function fakeCdn(files: Map<string, Buffer>, glitch?: (url: string, attempt: number) => Buffer | null) {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  const fetchImpl = jest.fn(async (url: string): Promise<FakeResponse> => {
    calls.push(url);
    const n = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, n);
    const file = url.split('/').pop()!;
    if (glitch) {
      const override = glitch(url, n);
      if (override) return fakeResponse(override);
    }
    const buf = files.get(file);
    if (!buf) throw new Error(`unexpected url ${url}`);
    return fakeResponse(buf);
  });
  return { fetchImpl, calls };
}

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['ANALYSIS_BIOWASM_MIRROR_URL', 'BIOMCP_CACHE_DIR'] as const;
let cacheRoot: string;

describe('biowasm registry validation', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    cacheRoot = join(tmpdir(), `biomcp-test-registry-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    process.env.BIOMCP_CACHE_DIR = cacheRoot;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k]!;
    }
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('pins every expected asset file', () => {
    for (const file of expectedAssetFileNames()) {
      expect(PINNED_SHA256[file]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(BIOWASM_TOOLS)).toEqual(['samtools', 'bedtools', 'bcftools']);
  });

  it('parses remote_package_size from a glue payload', () => {
    expect(parseRemotePackageSize(GLUE(120057).toString())).toBe(120057);
    expect(parseRemotePackageSize('var Module = 1;')).toBeNull();
  });

  it('validates js glue content', () => {
    expect(validateJsGlueContent('samtools.js', '').ok).toBe(false);
    expect(validateJsGlueContent('samtools.js', 'nothing here').ok).toBe(false);
    const ok = validateJsGlueContent('samtools.js', GLUE(42).toString());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.remotePackageSize).toBe(42);
  });

  it('validates wasm payloads compile', async () => {
    expect((await validateWasmBuffer('t.wasm', EMPTY_WASM)).ok).toBe(true);
    expect((await validateWasmBuffer('t.wasm', Buffer.from('garbage'))).ok).toBe(false);
    expect((await validateWasmBuffer('t.wasm', Buffer.alloc(0))).ok).toBe(false);
  });

  it('validates .data size against the glue size', () => {
    expect(validateDataSize('t.data', 100, 100).ok).toBe(true);
    const bad = validateDataSize('t.data', 99, 100);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('remote_package_size');
  });

  it('builds CDN urls from the pinned manifest', () => {
    expect(cdnFileUrl('samtools', 'samtools.wasm')).toBe('https://biowasm.com/cdn/v3/samtools/1.21/samtools.wasm');
    expect(cdnFileUrl('bedtools', 'bedtools.js')).toBe('https://biowasm.com/cdn/v3/bedtools/2.31.0/bedtools.js');
  });

  it('downloads, validates, and writes the state file; then skips via cache', async () => {
    const files = makeAssetSet(100);
    const pins = pinsFor(files);
    const { fetchImpl, calls } = fakeCdn(files);
    const res = await provisionBiowasmAssets(fetchImpl, pins);
    expect(res.origin).toBe('cdn');
    expect(existsSync(biowasmCacheStatePath())).toBe(true);
    for (const file of files.keys()) {
      expect(existsSync(join(res.dir, file))).toBe(true);
    }
    const downloadCalls = calls.length;
    expect(downloadCalls).toBe(9);
    // Second provisioning: served entirely from the cache state file.
    const again = await provisionBiowasmAssets(fetchImpl, pins);
    expect(again.origin).toBe('cache');
    expect(again.dir).toBe(res.dir);
    expect(fetchImpl).toHaveBeenCalledTimes(downloadCalls);
  });

  it('re-fetches once on a pin mismatch, then succeeds', async () => {
    const files = makeAssetSet(100);
    const pins = pinsFor(files);
    const glitchFile = 'bedtools.wasm';
    const wrong = Buffer.concat([files.get(glitchFile)!, Buffer.from([0x00])]);
    const { fetchImpl } = fakeCdn(files, (url, attempt) => {
      if (url.endsWith(glitchFile) && attempt === 1) return wrong;
      return null;
    });
    const res = await provisionBiowasmAssets(fetchImpl, pins);
    expect(res.origin).toBe('cdn');
    expect(existsSync(biowasmCacheStatePath())).toBe(true);
  });

  it('fails with an actionable error when a pin never matches', async () => {
    const files = makeAssetSet(100);
    const pins = pinsFor(files);
    const { fetchImpl } = fakeCdn(files, (url) => {
      if (url.endsWith('samtools.js')) return Buffer.concat([files.get('samtools.js')!, Buffer.from('//x')]);
      return null;
    });
    await expect(provisionBiowasmAssets(fetchImpl, pins)).rejects.toThrow(/sha256 mismatch for samtools\.js.*pin-assets\.mjs/s);
  });

  it('rejects a persistent data-size mismatch with an actionable error', async () => {
    const files = makeAssetSet(100);
    for (const k of [...files.keys()]) if (k.endsWith('.data')) files.set(k, Buffer.alloc(77, 7));
    const { fetchImpl } = fakeCdn(files);
    await expect(provisionBiowasmAssets(fetchImpl)).rejects.toThrow(/remote_package_size|mirror/i);
  });

  it('uses an env-provided directory mirror without network access', async () => {
    const mirror = join(cacheRoot, 'mirror');
    mkdirSync(mirror, { recursive: true });
    for (const [name, buf] of makeAssetSet(50)) writeFileSync(join(mirror, name), buf);
    process.env.ANALYSIS_BIOWASM_MIRROR_URL = mirror;
    const { fetchImpl } = fakeCdn(new Map());
    const res = await provisionBiowasmAssets(fetchImpl);
    expect(res.origin).toBe('env-dir');
    expect(res.dir).toBe(mirror);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an env mirror directory that is missing files', async () => {
    const mirror = join(cacheRoot, 'mirror-empty');
    mkdirSync(mirror, { recursive: true });
    process.env.ANALYSIS_BIOWASM_MIRROR_URL = mirror;
    await expect(provisionBiowasmAssets(jest.fn())).rejects.toThrow(/missing files: samtools\.js/);
  });

  it('rejects an env mirror value that is neither a path nor http(s)', async () => {
    process.env.ANALYSIS_BIOWASM_MIRROR_URL = 'not-a-real-thing://x';
    await expect(provisionBiowasmAssets(jest.fn())).rejects.toThrow(/ANALYSIS_BIOWASM_MIRROR_URL/);
  });

  it('reports a mismatched cached set and re-downloads from the CDN', async () => {
    const files = makeAssetSet(100);
    const { fetchImpl } = fakeCdn(files);
    const first = await provisionBiowasmAssets(fetchImpl, pinsFor(files));
    expect(first.origin).toBe('cdn');
    // Corrupt one cached file on disk; next provisioning must detect and refresh.
    writeFileSync(join(first.dir, 'samtools.data'), Buffer.alloc(10, 1));
    const second = await provisionBiowasmAssets(fetchImpl, pinsFor(files));
    expect(second.origin).toBe('cdn');
    expect(readFileSync(join(second.dir, 'samtools.data')).length).toBe(100);
  });

  it('cache dir path is derived from the pinned versions', () => {
    expect(biowasmCacheDirPath()).toContain(join(cacheRoot, 'biowasm-'));
  });
});

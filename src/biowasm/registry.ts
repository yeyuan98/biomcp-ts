import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cacheDir, extractTarGzArchive, sha256File } from '../wasmcore/assets.js';

/**
 * Pinned biowasm tool manifest. The biowasm CDN index carries no per-file
 * hashes and network corruption has been observed in the wild, so every file
 * is pinned at dev time via scripts/biowasm/pin-assets.mjs and verified at
 * download time.
 */
export const BIOWASM_TOOLS = {
  samtools: { version: '1.21', files: ['samtools.js', 'samtools.wasm', 'samtools.data'] },
  bedtools: { version: '2.31.0', files: ['bedtools.js', 'bedtools.wasm', 'bedtools.data'] },
  bcftools: { version: '1.10', files: ['bcftools.js', 'bcftools.wasm', 'bcftools.data'] },
} as const;

export type BiowasmToolName = keyof typeof BIOWASM_TOOLS;

export const BIOWASM_CDN = 'https://biowasm.com/cdn/v3';

export const PINNED_SHA256: Record<string, string> = {
  'bcftools.data': '586a06ce1ba23eef26f5b3b6b0f2cabeddf2a2b99f17cd06cffcbb0acc35d19f',
  'bcftools.js': '2e0118cbb252a4124e18ab370f58cd5e0f266329d17db2dc8592fe66b9480367',
  'bcftools.wasm': 'ae6ca30d70c97f8e8adea1c3de6c2f4cd67be693231f62275676989ae1dd0d9c',
  'bedtools.data': '859fb21116501704a568dea08ee322a4e9beb1c5a0a09fff35723bbf81484263',
  'bedtools.js': 'd38932a8d8cc3a11d3a10173d7eba782114d943fe5f55015d31d80f1ed0f4553',
  'bedtools.wasm': 'd3c6c93819a02022c89a80a3b8938a823d294567386363428079a3c3ef964c19',
  'samtools.data': '9fb04db92aa5c1169353144e803bd1a64c15e332cd8b0bea7598018c374b7aea',
  'samtools.js': 'c4cc0ece973ce2e0290297c15ee108fdd28d9b496b9b14c47982cde985e5887e',
  'samtools.wasm': '558dbfcacbed3bd71bb600ca48299c2ceb563f3c3aafe40eaed3a3c45cdbb7b3',
};

export const BIOWASM_TOOLS_ORDER: readonly BiowasmToolName[] = ['samtools', 'bedtools', 'bcftools'];

const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const STATE_FILE = 'biowasm-state.json';
const MIRROR_ENV_VAR = 'ANALYSIS_BIOWASM_MIRROR_URL';

export class BiowasmAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BiowasmAssetError';
  }
}

function fail(message: string): Error {
  return new BiowasmAssetError(message);
}

export type BiowasmFetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export type BiowasmAssetOrigin = 'cdn' | 'env-dir' | 'env-archive' | 'cache';

export interface BiowasmAssetResolution {
  dir: string;
  origin: BiowasmAssetOrigin;
}

// ---------------------------------------------------------------------------
// Pure validation helpers (unit-testable, no network / no filesystem).
// ---------------------------------------------------------------------------

/** Parse the remote_package_size field embedded in an Emscripten js glue. */
export function parseRemotePackageSize(js: string): number | null {
  const m = js.match(/remote_package_size"\s*:\s*(\d+)/);
  if (!m) return null;
  const size = Number(m[1]);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

export interface GlueValidation {
  remotePackageSize: number;
}

export function validateJsGlueContent(fileName: string, content: string): { ok: true; value: GlueValidation } | { ok: false; reason: string } {
  if (content.length === 0) {
    return { ok: false, reason: `${fileName}: js glue is empty` };
  }
  if (!/loadPackage|Module/.test(content)) {
    return { ok: false, reason: `${fileName}: js glue contains neither 'loadPackage' nor 'Module' markers` };
  }
  const remotePackageSize = parseRemotePackageSize(content);
  if (remotePackageSize === null) {
    return { ok: false, reason: `${fileName}: cannot parse remote_package_size from glue` };
  }
  return { ok: true, value: { remotePackageSize } };
}

/** A .wasm payload must compile. */
export async function validateWasmBuffer(fileName: string, content: Buffer): Promise<{ ok: boolean; reason?: string }> {
  if (content.length === 0) {
    return { ok: false, reason: `${fileName}: wasm file is empty` };
  }
  const wasm = (globalThis as unknown as { WebAssembly?: { compile(bytes: Buffer): Promise<unknown> } }).WebAssembly;
  if (!wasm) {
    return { ok: false, reason: `${fileName}: WebAssembly is unavailable in this runtime` };
  }
  try {
    await wasm.compile(content);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `${fileName}: does not compile as WebAssembly (${String((err as Error)?.message ?? err).slice(0, 120)})` };
  }
}

export function validateDataSize(fileName: string, actualBytes: number, expectedBytes: number): { ok: boolean; reason?: string } {
  if (actualBytes !== expectedBytes) {
    return { ok: false, reason: `${fileName}: size ${actualBytes} != remote_package_size ${expectedBytes} embedded in the .js glue (corrupt transfer)` };
  }
  return { ok: true };
}

export function expectedAssetFileNames(): string[] {
  return BIOWASM_TOOLS_ORDER.flatMap((tool) => BIOWASM_TOOLS[tool].files);
}

export function cdnFileUrl(tool: BiowasmToolName, file: string): string {
  return `${BIOWASM_CDN}/${tool}/${BIOWASM_TOOLS[tool].version}/${file}`;
}

/** Cache dir name: biowasm-<version-hash> where the hash covers tool versions. */
export function biowasmCacheDirName(): string {
  const spec: Record<string, string> = {};
  for (const tool of BIOWASM_TOOLS_ORDER) spec[tool] = BIOWASM_TOOLS[tool].version;
  const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
  return `biowasm-${hash}`;
}

export function biowasmCacheDirPath(): string {
  return join(cacheDir(), biowasmCacheDirName());
}

// ---------------------------------------------------------------------------
// Provisioning.
// ---------------------------------------------------------------------------

async function fetchFile(fetchImpl: BiowasmFetch, url: string): Promise<Buffer> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) {
        throw new Error('empty response body');
      }
      return buf;
    } catch (err) {
      lastError = String((err as Error)?.message ?? err);
    }
  }
  throw fail(`Download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${url} (${lastError})`);
}

interface ToolFileSet {
  [fileName: string]: Buffer;
}

async function downloadAndValidateFromCdn(fetchImpl: BiowasmFetch, pins: Record<string, string>): Promise<ToolFileSet> {
  const files: ToolFileSet = {};
  const glueSizes: Record<string, number> = {};
  for (const tool of BIOWASM_TOOLS_ORDER) {
    const spec = BIOWASM_TOOLS[tool];
    // Download the js glue first: its embedded remote_package_size is needed
    // to validate the .data payload.
    const order = [...spec.files].sort((a, b) => (a.endsWith('.js') ? -1 : b.endsWith('.js') ? 1 : 0));
    for (const file of order) {
      const url = cdnFileUrl(tool, file);
      let buf = await fetchFile(fetchImpl, url);
      // Pin check first: network corruption must recover via the one-shot
      // re-fetch rather than dying in structural validation.
      const pin = pins[file];
      if (pin && createHash('sha256').update(buf).digest('hex') !== pin) {
        buf = await fetchFile(fetchImpl, url);
        if (createHash('sha256').update(buf).digest('hex') !== pin) {
          throw fail(
            `sha256 mismatch for ${file}: expected ${pin}, got ${createHash('sha256').update(buf).digest('hex')}. ` +
              `The pinned biowasm assets may have changed upstream; re-run scripts/biowasm/pin-assets.mjs to refresh the pins, ` +
              `or set ${MIRROR_ENV_VAR}.`,
          );
        }
      }
      if (file.endsWith('.js')) {
        const glue = validateJsGlueContent(file, buf.toString('utf8'));
        if (!glue.ok) {
          throw fail(`${glue.reason}; retry with a fresh download or set ${MIRROR_ENV_VAR}`);
        }
        glueSizes[`${tool}.data`] = glue.value.remotePackageSize;
      }
      const validation = file.endsWith('.js')
        ? { ok: true as const }
        : file.endsWith('.wasm')
          ? await validateWasmBuffer(file, buf)
          : validateDataSize(file, buf.length, glueSizes[`${tool}.data`]);
      if (!validation.ok) {
        throw fail(`${validation.reason}; set ${MIRROR_ENV_VAR} to provision from a trusted mirror`);
      }
      files[file] = buf;
    }
  }
  return files;
}

function verifyPinSet(dir: string, label: string, pins: Record<string, string>): void {
  for (const file of expectedAssetFileNames()) {
    const p = join(dir, file);
    if (!existsSync(p)) {
      throw fail(`${label} is missing file: ${file}`);
    }
    const pin = pins[file];
    if (pin && sha256File(p) !== pin) {
      throw fail(
        `sha256 mismatch for ${file} in ${label}: expected ${pin}, got ${sha256File(p)}. ` +
          `Re-run scripts/biowasm/pin-assets.mjs if the pins are stale, or point ${MIRROR_ENV_VAR} at a matching bundle.`,
      );
    }
  }
}

function writeState(dir: string): void {
  const versions: Record<string, string> = {};
  for (const tool of BIOWASM_TOOLS_ORDER) versions[tool] = BIOWASM_TOOLS[tool].version;
  const files: Record<string, string> = {};
  for (const file of expectedAssetFileNames()) {
    files[file] = sha256File(join(dir, file));
  }
  writeFileSync(
    join(dir, STATE_FILE),
    JSON.stringify({ versions, files, verifiedAt: new Date().toISOString() }, null, 2),
  );
}

async function resolveFromEnvMirror(url: string, fetchImpl: BiowasmFetch, pins: Record<string, string>): Promise<BiowasmAssetResolution> {
  if (existsSync(url) && statSync(url).isDirectory()) {
    // A directory mirror is trusted as-is (R mirror semantics).
    const dir = resolve(url);
    const missing = expectedAssetFileNames().filter((f) => !existsSync(join(dir, f)));
    if (missing.length > 0) {
      throw fail(`${MIRROR_ENV_VAR} directory ${dir} is missing files: ${missing.join(', ')}`);
    }
    return { dir, origin: 'env-dir' };
  }
  let archivePath: string | null = null;
  if (existsSync(url) && /\.(tar\.gz|tgz)$/.test(url)) {
    archivePath = resolve(url);
  } else if (url.startsWith('file://')) {
    const p = decodeURIComponent(new URL(url).pathname);
    if (existsSync(p) && statSync(p).isDirectory()) {
      const missing = expectedAssetFileNames().filter((f) => !existsSync(join(p, f)));
      if (missing.length > 0) {
        throw fail(`${MIRROR_ENV_VAR} directory ${p} is missing files: ${missing.join(', ')}`);
      }
      return { dir: p, origin: 'env-dir' };
    }
    archivePath = p;
  } else if (/^https?:\/\//.test(url)) {
    const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    archivePath = join(cacheDir(), `biowasm-mirror-${urlHash}.tar.gz`);
    try {
      const buf = await fetchFile(fetchImpl, url);
      writeFileSync(archivePath, buf);
    } catch (err) {
      if (!existsSync(archivePath)) throw err;
    }
  }
  if (!archivePath) {
    throw fail(`${MIRROR_ENV_VAR} must be an existing directory, a .tar.gz archive path/URL, or an http(s) URL: "${url}"`);
  }
  const bundleHash = sha256File(archivePath);
  let dir = join(cacheDir(), `biowasm-mirror-${bundleHash.slice(0, 16)}`);
  if (!existsSync(join(dir, STATE_FILE))) {
    rmSync(dir, { recursive: true, force: true });
    extractTarGzArchive(archivePath, dir, fail, 'Biowasm mirror');
    // The archive may nest the flat files under a single directory.
    if (!existsSync(join(dir, 'samtools.js'))) {
      let nestedDir: string | null = null;
      const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          if (nestedDir) return;
          if (entry.isDirectory()) walk(join(d, entry.name));
          else if (entry.isFile() && entry.name === 'samtools.js') nestedDir = d;
        }
      };
      walk(dir);
      if (!nestedDir) {
        rmSync(dir, { recursive: true, force: true });
        throw fail(`Biowasm mirror bundle ${archivePath} contains none of the expected files (${expectedAssetFileNames().join(', ')}).`);
      }
      dir = nestedDir;
    }
    verifyPinSet(dir, `biowasm mirror bundle ${archivePath}`, pins);
    writeState(dir);
  }
  return { dir, origin: 'env-archive' };
}

/**
 * Provision the pinned biowasm assets, downloading from the CDN (default) or
 * the ANALYSIS_BIOWASM_MIRROR_URL override. Cached asset sets are skipped via
 * the state file (R mirror state-file pattern) after cheap pin verification.
 */
export async function provisionBiowasmAssets(
  fetchImpl: BiowasmFetch = (url) =>
    fetch(url, {
      headers: { 'User-Agent': 'biomcp-biowasm' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    }),
  pins: Record<string, string> = PINNED_SHA256,
): Promise<BiowasmAssetResolution> {
  const envUrl = process.env[MIRROR_ENV_VAR];
  if (envUrl) {
    return resolveFromEnvMirror(envUrl, fetchImpl, pins);
  }
  const dir = biowasmCacheDirPath();
  const statePath = join(dir, STATE_FILE);
  if (existsSync(statePath) && expectedAssetFileNames().every((f) => existsSync(join(dir, f)))) {
    try {
      verifyPinSet(dir, `biowasm asset cache ${dir}`, pins);
      return { dir, origin: 'cache' };
    } catch {
      // Fall through to a fresh CDN download (re-fetch-on-mismatch semantics).
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const files = await downloadAndValidateFromCdn(fetchImpl, pins);
  mkdirSync(dir, { recursive: true });
  for (const [file, buf] of Object.entries(files)) {
    const tmp = join(dir, `${file}.part`);
    writeFileSync(tmp, buf);
    renameSync(tmp, join(dir, file));
  }
  writeState(dir);
  return { dir, origin: 'cdn' };
}

export function biowasmCacheStatePath(): string {
  return join(biowasmCacheDirPath(), STATE_FILE);
}

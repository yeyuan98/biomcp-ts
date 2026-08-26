import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_GITHUB_REPO = 'yeyuan98/biomcp-ts';
const ASSET_NAME_RE = /^r-wasm-mirror-.*\.tar\.gz$/;
const CACHE_ROOT = join(homedir(), '.cache', 'biomcp');

export interface MirrorManifest {
  files?: Array<{ name: string; sha256: string }>;
  packages?: Record<string, string>;
  created?: string;
}

export interface MirrorResolution {
  dir: string;
  manifest?: MirrorManifest;
  origin: 'env-dir' | 'env-archive' | 'release' | 'cache';
}

export class MirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MirrorError';
  }
}

function sha256File(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

function cacheDir(): string {
  const root = process.env.BIOMCP_CACHE_DIR ?? CACHE_ROOT;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function statePath(): string {
  return join(cacheDir(), 'r-wasm-mirror-state.json');
}

interface MirrorState {
  assetName?: string;
  digest?: string;
  bundleHash?: string;
  dir?: string;
}

function readState(): MirrorState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state: MirrorState): void {
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function extractTarGz(tarPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { encoding: 'buffer' });
  if (r.status !== 0) {
    rmSync(destDir, { recursive: true, force: true });
    throw new MirrorError(`Failed to extract mirror bundle (tar exit ${r.status}): ${(r.stderr ?? '').toString().slice(0, 500)}`);
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'biomcp-ranalysis' },
  });
  if (!res.ok) throw new MirrorError(`GitHub API request failed (${res.status}) for ${url}.`);
  return res.json();
}

async function downloadTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'biomcp-ranalysis' } });
  if (!res.ok || !res.body) throw new MirrorError(`Mirror download failed (${res.status}) for ${url}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
}

function verifyManifest(dir: string): MirrorManifest {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return {};
  const manifest: MirrorManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = manifest.files ?? [];
  for (const f of files) {
    const p = resolve(dir, f.name);
    if (!p.startsWith(resolve(dir))) throw new MirrorError(`Manifest entry escapes bundle dir: ${f.name}`);
    if (!existsSync(p)) throw new MirrorError(`Mirror bundle is missing file: ${f.name}`);
    const got = sha256File(p);
    if (got !== f.sha256) {
      rmSync(dir, { recursive: true, force: true });
      throw new MirrorError(`Checksum mismatch for ${f.name}: expected ${f.sha256}, got ${got}. Bundle deleted; retry or set ANALYSIS_R_MIRROR_URL.`);
    }
  }
  return manifest;
}

async function resolveFromGitHub(): Promise<MirrorResolution> {
  const repo = process.env.ANALYSIS_R_GITHUB_REPO ?? DEFAULT_GITHUB_REPO;
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const assets: any[] = release.assets ?? [];
  const asset = assets.find((a) => ASSET_NAME_RE.test(a.name ?? ''));
  if (!asset) {
    throw new MirrorError(
      `Latest release of ${repo} has no r-wasm-mirror asset (assets: ${assets.map((a) => a.name).join(', ') || 'none'}). Set ANALYSIS_R_MIRROR_URL to provide a mirror manually.`
    );
  }
  const digest: string | undefined = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
    ? asset.digest.slice(7)
    : undefined;
  const marker = digest ?? asset.updated_at ?? String(asset.id);
  const state = readState();
  if (state.digest === marker && state.dir && existsSync(state.dir) && existsSync(join(state.dir, 'manifest.json'))) {
    return { dir: state.dir, manifest: safeReadManifest(state.dir), origin: 'cache' };
  }
  const tarPath = join(cacheDir(), `r-wasm-mirror-download-${Date.now()}.tar.gz`);
  await downloadTo(asset.browser_download_url, tarPath);
  if (digest && sha256File(tarPath) !== digest) {
    rmSync(tarPath, { force: true });
    throw new MirrorError('Downloaded mirror asset hash does not match the GitHub-reported digest.');
  }
  const bundleHash = sha256File(tarPath);
  const dir = join(cacheDir(), `r-wasm-mirror-${bundleHash.slice(0, 16)}`);
  if (!existsSync(join(dir, 'manifest.json'))) {
    rmSync(dir, { recursive: true, force: true });
    extractTarGz(tarPath, dir);
  }
  rmSync(tarPath, { force: true });
  const manifest = verifyManifest(dir);
  writeState({ assetName: asset.name, digest: marker, bundleHash, dir });
  return { dir, manifest, origin: 'release' };
}

function safeReadManifest(dir: string): MirrorManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function resolveFromEnv(url: string): Promise<MirrorResolution> {
  if (existsSync(url) && statSync(url).isDirectory()) {
    return { dir: resolve(url), manifest: safeReadManifest(resolve(url)), origin: 'env-dir' };
  }
  if (existsSync(url) && /\.(tar\.gz|tgz)$/.test(url)) {
    return extractEnvArchive(resolve(url));
  }
  if (url.startsWith('file://')) {
    const p = fileUrlToPath(url);
    if (existsSync(p) && statSync(p).isDirectory()) return { dir: p, manifest: safeReadManifest(p), origin: 'env-dir' };
    return extractEnvArchive(p);
  }
  if (/^https?:\/\//.test(url)) {
    const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const dir = join(cacheDir(), `r-wasm-mirror-url-${urlHash}`);
    if (!existsSync(join(dir, 'manifest.json'))) {
      const tarPath = join(cacheDir(), `r-wasm-mirror-url-${urlHash}.tar.gz`);
      await downloadTo(url, tarPath);
      rmSync(dir, { recursive: true, force: true });
      extractTarGz(tarPath, dir);
      rmSync(tarPath, { force: true });
    }
    const manifest = verifyManifest(dir);
    return { dir, manifest, origin: 'env-archive' };
  }
  throw new MirrorError(
    `ANALYSIS_R_MIRROR_URL must be an existing directory, a .tar.gz archive path/URL, or an http(s) URL: "${url}".`
  );
}

function extractEnvArchive(archivePath: string): MirrorResolution {
  const bundleHash = sha256File(archivePath);
  const dir = join(cacheDir(), `r-wasm-mirror-${bundleHash.slice(0, 16)}`);
  if (!existsSync(join(dir, 'manifest.json'))) {
    rmSync(dir, { recursive: true, force: true });
    extractTarGz(archivePath, dir);
  }
  const manifest = verifyManifest(dir);
  return { dir, manifest, origin: 'env-archive' };
}

function fileUrlToPath(url: string): string {
  return decodeURIComponent(new URL(url).pathname);
}

let resolved: MirrorResolution | null = null;

export async function resolveMirror(): Promise<MirrorResolution> {
  if (resolved) return resolved;
  const envUrl = process.env.ANALYSIS_R_MIRROR_URL;
  resolved = envUrl ? await resolveFromEnv(envUrl) : await resolveFromGitHub();
  return resolved;
}

export function resetMirrorForTests(): void {
  resolved = null;
}

const MIME: Record<string, string> = {
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.data': 'application/octet-stream',
  '.rds': 'application/octet-stream',
};

export class MirrorServer {
  private server: Server | null = null;
  private port = 0;

  async start(dir: string): Promise<string> {
    if (this.server) return this.url();
    const root = resolve(dir);
    const server = createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? '').split('?')[0]);
      const p = resolve(join(root, url.replace(/^\/+/, '')));
      if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(p)] ?? 'text/plain',
        'content-length': statSync(p).size,
        'access-control-allow-origin': '*',
      });
      createReadStream(p).pipe(res);
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        resolvePromise();
      });
    });
    this.server = server;
    return this.url();
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

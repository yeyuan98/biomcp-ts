import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const CACHE_ROOT = join(homedir(), '.cache', 'biomcp');
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_ASSET_TIMEOUT_MS = 600_000;

export interface AssetManifest {
  files?: Array<{ name: string; sha256: string }>;
  packages?: Record<string, string>;
  created?: string;
}

export type AssetOrigin = 'env-dir' | 'env-archive' | 'release' | 'cache';

export interface AssetResolution {
  dir: string;
  manifest?: AssetManifest;
  origin: AssetOrigin;
}

export type AssetErrorCtor = new (message: string) => Error;

export interface AssetStoreConfig {
  errorCtor: AssetErrorCtor;
  label: string;
  envVar: string;
  repoEnvVar: string;
  defaultRepo: string;
  assetNameRe: RegExp;
  assetLabel: string;
  userAgent: string;
  downloadTimeoutMs?: number;
  assetTimeoutMs?: number;
}

interface AssetState {
  assetName?: string;
  digest?: string;
  bundleHash?: string;
  dir?: string;
}

export function sha256File(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

/**
 * Extract a tar.gz archive into destDir with path-traversal protection.
 * Shared by VerifiedAssetStore and dependents that resolve archive mirrors.
 */
export function extractTarGzArchive(tarPath: string, destDir: string, fail: (message: string) => Error, label: string): void {
  mkdirSync(destDir, { recursive: true });
  const listing = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
  if (listing.status !== 0) {
    rmSync(destDir, { recursive: true, force: true });
    throw fail(`${label} bundle is not a valid tar.gz archive: ${listing.stderr.slice(0, 300)}`);
  }
  for (const member of (listing.stdout ?? '').split('\n')) {
    if (member === '' || member === './' || member === '.') continue;
    if (member.startsWith('/') || member.split('/').includes('..')) {
      rmSync(destDir, { recursive: true, force: true });
      throw fail(`${label} bundle contains an unsafe member path: ${member}`);
    }
  }
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { encoding: 'buffer' });
  if (r.status !== 0) {
    rmSync(destDir, { recursive: true, force: true });
    throw fail(`Failed to extract ${label.toLowerCase()} bundle (tar exit ${r.status}): ${(r.stderr ?? '').toString().slice(0, 500)}`);
  }
}

export function cacheDir(): string {
  const root = process.env.BIOMCP_CACHE_DIR ?? CACHE_ROOT;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

function fileUrlToPath(url: string): string {
  return decodeURIComponent(new URL(url).pathname);
}

export class VerifiedAssetStore {
  private resolved: AssetResolution | null = null;

  constructor(private readonly cfg: AssetStoreConfig) {}

  reset(): void {
    this.resolved = null;
  }

  async resolve(): Promise<AssetResolution> {
    if (this.resolved) return this.resolved;
    const envUrl = process.env[this.cfg.envVar];
    this.resolved = envUrl ? await this.resolveFromEnv(envUrl) : await this.resolveFromGitHub();
    return this.resolved;
  }

  private fail(message: string): Error {
    return new this.cfg.errorCtor(message);
  }

  private extractTarGz(tarPath: string, destDir: string): void {
    extractTarGzArchive(tarPath, destDir, (message) => this.fail(message), this.cfg.label);
  }

  private async fetchJson(url: string): Promise<any> {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': this.cfg.userAgent },
      signal: AbortSignal.timeout(this.cfg.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw this.fail(`GitHub API request failed (${res.status}) for ${url}.`);
    return res.json();
  }

  private async downloadTo(url: string, destPath: string): Promise<void> {
    const res = await fetch(url, {
      headers: { 'User-Agent': this.cfg.userAgent },
      signal: AbortSignal.timeout(this.cfg.assetTimeoutMs ?? DEFAULT_ASSET_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw this.fail(`${this.cfg.label} download failed (${res.status}) for ${url}.`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(destPath, buf);
  }

  private verifyManifest(dir: string): AssetManifest {
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) return {};
    const manifest: AssetManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const files = manifest.files ?? [];
    for (const f of files) {
      const rootDir = resolve(dir);
      const p = resolve(dir, f.name);
      if (!(p === rootDir || p.startsWith(rootDir + sep))) throw this.fail(`Manifest entry escapes bundle dir: ${f.name}`);
      if (!existsSync(p)) throw this.fail(`${this.cfg.label} bundle is missing file: ${f.name}`);
      const got = sha256File(p);
      if (got !== f.sha256) {
        rmSync(dir, { recursive: true, force: true });
        throw this.fail(`Checksum mismatch for ${f.name}: expected ${f.sha256}, got ${got}. Bundle deleted; retry or set ${this.cfg.envVar}.`);
      }
    }
    return manifest;
  }

  private async resolveFromGitHub(): Promise<AssetResolution> {
    const { assetLabel, assetNameRe, envVar, label, repoEnvVar } = this.cfg;
    const repo = process.env[repoEnvVar] ?? this.cfg.defaultRepo;
    const release = await this.fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
    const assets: any[] = release.assets ?? [];
    const asset = assets.find((a) => assetNameRe.test(a.name ?? ''));
    if (!asset) {
      throw this.fail(
        `Latest release of ${repo} has no ${assetLabel} asset (assets: ${assets.map((a) => a.name).join(', ') || 'none'}). Set ${envVar} to provide a mirror manually.`
      );
    }
    const digest: string | undefined = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
      ? asset.digest.slice(7)
      : undefined;
    const marker = digest ?? asset.updated_at ?? String(asset.id);
    const state = this.readState();
    if (state.digest === marker && state.dir && existsSync(state.dir) && existsSync(join(state.dir, 'manifest.json'))) {
      return { dir: state.dir, manifest: this.safeReadManifest(state.dir), origin: 'cache' };
    }
    const tarPath = join(cacheDir(), `${assetLabel}-download-${Date.now()}.tar.gz`);
    await this.downloadTo(asset.browser_download_url, tarPath);
    if (digest && sha256File(tarPath) !== digest) {
      rmSync(tarPath, { force: true });
      throw this.fail(`Downloaded ${label.toLowerCase()} asset hash does not match the GitHub-reported digest.`);
    }
    const bundleHash = sha256File(tarPath);
    const dir = join(cacheDir(), `${assetLabel}-${bundleHash.slice(0, 16)}`);
    if (!existsSync(join(dir, 'manifest.json'))) {
      rmSync(dir, { recursive: true, force: true });
      this.extractTarGz(tarPath, dir);
    }
    rmSync(tarPath, { force: true });
    const manifest = this.verifyManifest(dir);
    this.writeState({ assetName: asset.name, digest: marker, bundleHash, dir });
    return { dir, manifest, origin: 'release' };
  }

  private safeReadManifest(dir: string): AssetManifest | undefined {
    try {
      return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    } catch {
      return undefined;
    }
  }

  private statePath(): string {
    return join(cacheDir(), `${this.cfg.assetLabel}-state.json`);
  }

  private readState(): AssetState {
    try {
      return JSON.parse(readFileSync(this.statePath(), 'utf8'));
    } catch {
      return {};
    }
  }

  private writeState(state: AssetState): void {
    writeFileSync(this.statePath(), JSON.stringify(state, null, 2));
  }

  private async resolveFromEnv(url: string): Promise<AssetResolution> {
    if (existsSync(url) && statSync(url).isDirectory()) {
      return { dir: resolve(url), manifest: this.safeReadManifest(resolve(url)), origin: 'env-dir' };
    }
    if (existsSync(url) && /\.(tar\.gz|tgz)$/.test(url)) {
      return this.extractEnvArchive(resolve(url));
    }
    if (url.startsWith('file://')) {
      const p = fileUrlToPath(url);
      if (existsSync(p) && statSync(p).isDirectory()) return { dir: p, manifest: this.safeReadManifest(p), origin: 'env-dir' };
      return this.extractEnvArchive(p);
    }
    if (/^https?:\/\//.test(url)) {
      const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
      const dir = join(cacheDir(), `${this.cfg.assetLabel}-url-${urlHash}`);
      if (!existsSync(join(dir, 'manifest.json'))) {
        const tarPath = join(cacheDir(), `${this.cfg.assetLabel}-url-${urlHash}.tar.gz`);
        await this.downloadTo(url, tarPath);
        rmSync(dir, { recursive: true, force: true });
        this.extractTarGz(tarPath, dir);
        rmSync(tarPath, { force: true });
      }
      const manifest = this.verifyManifest(dir);
      return { dir, manifest, origin: 'env-archive' };
    }
    throw this.fail(
      `${this.cfg.envVar} must be an existing directory, a .tar.gz archive path/URL, or an http(s) URL: "${url}".`
    );
  }

  private extractEnvArchive(archivePath: string): AssetResolution {
    const bundleHash = sha256File(archivePath);
    const dir = join(cacheDir(), `${this.cfg.assetLabel}-${bundleHash.slice(0, 16)}`);
    if (!existsSync(join(dir, 'manifest.json'))) {
      rmSync(dir, { recursive: true, force: true });
      this.extractTarGz(archivePath, dir);
    }
    const manifest = this.verifyManifest(dir);
    return { dir, manifest, origin: 'env-archive' };
  }
}

export class StaticFileServer {
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly mime: Record<string, string> = {}) {}

  async start(dir: string): Promise<string> {
    if (this.server) return this.url();
    const root = resolve(dir);
    const files = new Map<string, string>();
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      const abs = join(root, entry);
      if (statSync(abs).isFile()) {
        files.set('/' + entry.split(sep).join('/'), abs);
      }
    }
    const server = createServer((req, res) => {
      let key: string;
      try {
        key = decodeURIComponent((req.url ?? '').split('?')[0]);
      } catch {
        res.writeHead(400);
        res.end('bad request');
        return;
      }
      const f = files.get(key);
      if (!f) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const size = statSync(f).size;
      res.writeHead(200, {
        'content-type': this.mime[extname(f)] ?? 'text/plain',
        'content-length': size,
        'access-control-allow-origin': '*',
      });
      createReadStream(f).pipe(res);
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

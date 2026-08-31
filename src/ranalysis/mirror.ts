import '../connections/proxy.js';
import { StaticFileServer, VerifiedAssetStore } from '../wasmcore/assets.js';
import type { AssetManifest, AssetResolution } from '../wasmcore/assets.js';

export const DEFAULT_GITHUB_REPO = 'yeyuan98/biomcp-ts';
const ASSET_NAME_RE = /^r-wasm-mirror-.*\.tar\.gz$/;

const DEFAULT_ASSET_TIMEOUT_MS = 600_000;
const MIN_ASSET_TIMEOUT_MS = 30_000;
const MAX_ASSET_TIMEOUT_MS = 3_600_000;
export const ASSET_TIMEOUT_BOUNDS = { min: MIN_ASSET_TIMEOUT_MS, max: MAX_ASSET_TIMEOUT_MS, default: DEFAULT_ASSET_TIMEOUT_MS } as const;

/**
 * Env read is intentionally lazy (getStore), NOT at module evaluation: the
 * server fills env from .biomcp.json AFTER this module loads, so an eager
 * read would silently ignore file-set `features.analysis_r.asset_timeout_ms`.
 * Out-of-range raw env values are CLAMPED to the bounds here (env bypasses
 * registry validation); file-set values outside the bounds are REJECTED by
 * the registry schema (the whole file is refused, not clamped).
 */
function assetTimeoutMsFromEnv(): number {
  const raw = process.env['ANALYSIS_R_ASSET_TIMEOUT_MS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_ASSET_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ASSET_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), MIN_ASSET_TIMEOUT_MS), MAX_ASSET_TIMEOUT_MS);
}

export function assetTimeoutRemediation(timeoutMs: number): string {
  return (
    `Raise the limit via features.analysis_r.asset_timeout_ms (or ANALYSIS_R_ASSET_TIMEOUT_MS; currently ${Math.round(
      timeoutMs / 1000
    )}s, max 3600s), or fetch the release asset yourself (gh release download / curl) and set features.analysis_r.mirror_url to the local file (confirm_sensitive: true).`
  );
}

function apiTimeoutRemediation(timeoutMs: number): string {
  return (
    `This was the GitHub API metadata call (${Math.round(timeoutMs / 1000)}s budget, not the bundle download — asset_timeout_ms does not govern it). ` +
      `Check network/proxy access to api.github.com, or fetch the release asset yourself and set features.analysis_r.mirror_url to skip the API entirely.`
  );
}

export type MirrorManifest = AssetManifest;
export type MirrorResolution = AssetResolution;

export class MirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MirrorError';
  }
}

let store: VerifiedAssetStore | undefined;

function getStore(): VerifiedAssetStore {
  store ??= new VerifiedAssetStore({
    errorCtor: MirrorError,
    label: 'Mirror',
    envVar: 'ANALYSIS_R_MIRROR_URL',
    repoEnvVar: 'ANALYSIS_R_GITHUB_REPO',
    defaultRepo: DEFAULT_GITHUB_REPO,
    assetNameRe: ASSET_NAME_RE,
    assetLabel: 'r-wasm-mirror',
    userAgent: 'biomcp-ranalysis',
    assetTimeoutMs: assetTimeoutMsFromEnv(),
    timeoutRemediation: assetTimeoutRemediation,
    apiTimeoutRemediation,
  });
  return store;
}

export async function resolveMirror(): Promise<MirrorResolution> {
  return getStore().resolve();
}

export function resetMirrorForTests(): void {
  store = undefined;
}

const MIME: Record<string, string> = {
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.data': 'application/octet-stream',
  '.rds': 'application/octet-stream',
};

export class MirrorServer extends StaticFileServer {
  constructor() {
    super(MIME);
  }
}

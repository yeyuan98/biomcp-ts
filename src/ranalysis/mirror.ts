import '../connections/proxy.js';
import { StaticFileServer, VerifiedAssetStore } from '../wasmcore/assets.js';
import type { AssetManifest, AssetResolution } from '../wasmcore/assets.js';

export const DEFAULT_GITHUB_REPO = 'yeyuan98/biomcp-ts';
const ASSET_NAME_RE = /^r-wasm-mirror-.*\.tar\.gz$/;

export type MirrorManifest = AssetManifest;
export type MirrorResolution = AssetResolution;

export class MirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MirrorError';
  }
}

const store = new VerifiedAssetStore({
  errorCtor: MirrorError,
  label: 'Mirror',
  envVar: 'ANALYSIS_R_MIRROR_URL',
  repoEnvVar: 'ANALYSIS_R_GITHUB_REPO',
  defaultRepo: DEFAULT_GITHUB_REPO,
  assetNameRe: ASSET_NAME_RE,
  assetLabel: 'r-wasm-mirror',
  userAgent: 'biomcp-ranalysis',
});

export async function resolveMirror(): Promise<MirrorResolution> {
  return store.resolve();
}

export function resetMirrorForTests(): void {
  store.reset();
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

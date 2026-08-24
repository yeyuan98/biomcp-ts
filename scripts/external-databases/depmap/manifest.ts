import { parseCsvString } from './csv.js';

export const MANIFEST_URL = 'https://depmap.org/portal/api/no-captcha/download/files';

export interface ManifestRow {
  release: string;
  releaseDate: string;
  filename: string;
  url: string;
  md5: string;
}

export interface ReleaseFiles {
  name: string;
  shortName: string;
  date: string;
  files: Map<string, string>;
}

const RELEASE_NAME_RE = /^DepMap Public (\d{2})Q([1-4])$/;

export function parseManifest(text: string): ManifestRow[] {
  const rows = parseCsvString(text);
  if (rows.length < 2) {
    throw new Error('DepMap manifest is empty or has no data rows');
  }
  const header = rows[0];
  const expected = ['release', 'release_date', 'filename', 'url', 'md5_hash'];
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) {
      throw new Error(
        `Unexpected DepMap manifest header: expected "${expected.join(',')}" but got "${header.join(',')}"`
      );
    }
  }
  return rows.slice(1).filter(r => r.length >= 5).map(r => ({
    release: r[0],
    releaseDate: r[1],
    filename: r[2],
    url: r[3],
    md5: r[4],
  }));
}

export function selectLatestRelease(rows: ManifestRow[]): ReleaseFiles {
  const candidates = new Map<string, { year: number; quarter: number }>();
  for (const row of rows) {
    const match = RELEASE_NAME_RE.exec(row.release);
    if (!match) continue;
    const key = `${match[1]}Q${match[2]}`;
    if (!candidates.has(key)) candidates.set(key, { year: Number(match[1]), quarter: Number(match[2]) });
  }
  if (candidates.size === 0) {
    throw new Error('No "DepMap Public <YY>Q<Q>" releases found in the manifest');
  }
  let bestKey: string | null = null;
  let best: { year: number; quarter: number } | null = null;
  for (const [key, value] of candidates) {
    if (!best || value.year > best.year || (value.year === best.year && value.quarter > best.quarter)) {
      bestKey = key;
      best = value;
    }
  }
  const releaseRows = rows.filter(r => RELEASE_NAME_RE.test(r.release) && r.release === `DepMap Public ${bestKey}`);
  const files = new Map<string, string>();
  let date = '';
  for (const row of releaseRows) {
    if (files.has(row.filename)) {
      throw new Error(`Duplicate manifest entry for ${releaseRows[0].release}/${row.filename}`);
    }
    files.set(row.filename, row.md5);
    if (!date && row.releaseDate) date = row.releaseDate;
  }
  return { name: `DepMap Public ${bestKey}`, shortName: bestKey!, date, files };
}

export async function fetchManifest(path?: string): Promise<string> {
  if (path) {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8');
  }
  const headers = { Accept: 'text/csv' };
  const signal = AbortSignal.timeout(30_000);
  const proxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (proxy) {
    const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici');
    const response = await undiciFetch(MANIFEST_URL, {
      dispatcher: new EnvHttpProxyAgent(),
      headers,
      signal,
    });
    if (!response.ok) {
      throw new Error(`Manifest fetch failed: HTTP ${response.status} from ${MANIFEST_URL}`);
    }
    return response.text();
  }
  const response = await fetch(MANIFEST_URL, { headers, signal });
  if (!response.ok) {
    throw new Error(`Manifest fetch failed: HTTP ${response.status} from ${MANIFEST_URL}`);
  }
  return response.text();
}

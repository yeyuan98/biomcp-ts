import { gunzipSync } from 'node:zlib';
import { fetchWithTimeout } from '../../../connections/fetch-utils.js';

interface WaybackAvailability {
  archived_snapshots?: {
    closest?: {
      url?: string;
      timestamp?: string;
      status?: string;
      available?: boolean;
    };
  };
}

/**
 * Resolve a URL to an archived Wayback snapshot (original-bytes `id_` form).
 * Returns null when no snapshot exists.
 */
export async function findWaybackSnapshot(
  targetUrl: string,
  timeoutMs = 15000
): Promise<{ idUrl: string; timestamp: string } | null> {
  const { data, error } = await fetchWithTimeout(async (signal) => {
    const resp = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'biomcp-patent/1.0' }, signal },
    );
    return resp.text();
  }, timeoutMs);

  if (error || !data) return null;

  let parsed: WaybackAvailability;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }

  const closest = parsed.archived_snapshots?.closest;
  if (!closest?.url || !closest.timestamp) return null;

  // A snapshot that is not available, or whose capture is a 4xx/5xx status
  // page, can never serve playable original bytes — skip the doomed fetch.
  const status = Number(closest.status);
  if (closest.available === false || !(status >= 200 && status < 400)) return null;

  return {
    idUrl: `https://web.archive.org/web/${closest.timestamp}id_/${targetUrl}`,
    timestamp: closest.timestamp,
  };
}

/**
 * Fetch Wayback original bytes. Some snapshots serve gzip without a
 * Content-Encoding header, so sniff the magic bytes and decompress.
 */
export async function fetchWaybackOriginal(
  idUrl: string,
  timeoutMs = 60000
): Promise<string | null> {
  const { data, error } = await fetchWithTimeout(async (signal) => {
    const resp = await fetch(idUrl, {
      headers: { 'User-Agent': 'biomcp-patent/1.0' },
      signal,
      redirect: 'follow',
    });
    if (!resp.ok) {
      throw new Error(`Wayback fetch failed: HTTP ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return gunzipSync(Buffer.from(buf)).toString('utf-8');
    }
    return new TextDecoder('utf-8').decode(buf);
  }, timeoutMs);

  if (error || !data) return null;
  return data;
}

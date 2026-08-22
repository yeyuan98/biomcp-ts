import { connectionManager } from '../../../connections/manager.js';
import { fetchWithTimeout } from '../../../connections/fetch-utils.js';
import { parseGooglePatentHtml, type ParsedGooglePatent } from './parse.js';
import { findWaybackSnapshot, fetchWaybackOriginal } from './wayback.js';

const BLOCK_SIGNATURES = ['Sorry...', 'automated queries'];

let liveBlockedUntil = 0;

export function isGooglePatentsDetailBlocked(): boolean {
  return Date.now() < liveBlockedUntil;
}

function looksLikeBlockPage(html: string): boolean {
  return BLOCK_SIGNATURES.some(sig => html.includes(sig));
}

/**
 * Fetch a Google Patents detail page and parse it.
 *
 * Order: live fetch → on block/signature miss → Wayback snapshot (original
 * bytes, gzip-sniffed). Google Patents is unofficial and hard-IP-blocks
 * aggressive clients (verified), so the fallback is mandatory.
 */
export async function fetchGooglePatentDetail(publicationNumber: string): Promise<ParsedGooglePatent> {
  const canonical = publicationNumber.replace(/\s+/g, '').toUpperCase();
  const targetUrl = `https://patents.google.com/patent/${canonical}/en`;

  if (!isGooglePatentsDetailBlocked()) {
    try {
      const html = await fetchLiveDetail(targetUrl);
      if (html) {
        if (looksLikeBlockPage(html)) {
          liveBlockedUntil = Date.now() + 30 * 60 * 1000;
        } else {
          const parsed = parseGooglePatentHtml(html);
          if (parsed.title || parsed.publication_number || parsed.abstract) {
            return parsed;
          }
        }
      }
    } catch {
      // fall through to Wayback
    }
  }

  const snapshot = await findWaybackSnapshot(targetUrl);
  if (snapshot) {
    const html = await fetchWaybackOriginal(snapshot.idUrl);
    if (html && !looksLikeBlockPage(html)) {
      const parsed = parseGooglePatentHtml(html);
      if (parsed.title || parsed.publication_number || parsed.abstract) {
        return parsed;
      }
    }
  }

  throw new Error(
    `Google Patents detail unavailable for ${canonical} (live fetch failed or blocked, no Wayback snapshot). ` +
    'For US patents use PPUBS; for worldwide coverage configure EPO OPS credentials (EPO_OPS_CONSUMER_KEY/EPO_OPS_CONSUMER_SECRET).',
  );
}

async function fetchLiveDetail(targetUrl: string): Promise<string | null> {
  const conn = connectionManager.getConnection('google_patents');
  try {
    const path = new URL(targetUrl).pathname + new URL(targetUrl).search;
    const text = await conn.request(path) as string;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

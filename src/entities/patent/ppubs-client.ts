import { TokenBucketRateLimiter } from '../../connections/rate-limiter.js';
import { fetchWithTimeout } from '../../connections/fetch-utils.js';

const PPUBS_BASE = 'https://ppubs.uspto.gov';
const REFERER = `${PPUBS_BASE}/pubwebapp/`;
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SESSION_TTL_MS = 25 * 60 * 1000;

export interface PpubsSession {
  token: string;
  caseId: number;
  expiresAt: number;
}

interface PpubsResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function searchBody(
  caseId: number,
  q: string,
  start: number,
  pageCount: number,
  databases: string[],
  sort: string,
): Record<string, unknown> {
  return {
    start,
    pageCount,
    sort,
    docFamilyFiltering: 'familyIdFiltering',
    searchType: 1,
    familyIdEnglishOnly: true,
    familyIdFirstPreferred: 'US-PGPUB',
    familyIdSecondPreferred: 'USPAT',
    familyIdThirdPreferred: 'FPRS',
    showDocPerFamilyPref: 'showEnglish',
    queryId: 0,
    tagDocSearch: false,
    query: {
      caseId,
      hl_snippets: '2',
      op: 'AND',
      q,
      queryName: q,
      userEnteredQuery: q,
      highlights: '1',
      qt: 'brs',
      spellCheck: false,
      viewName: 'tile',
      plurals: true,
      britishEquivalents: true,
      databaseFilters: databases.map(name => ({ databaseName: name, countryCodes: [] })),
      searchType: 1,
      ignorePersist: true,
    },
  };
}

/**
 * Session client for the USPTO Patent Public Search (PPUBS) internal API.
 *
 * Keyless. Requires a session handshake (POST /api/users/me/session) that
 * yields an access token header and a caseId embedded in every search body.
 * Session establishment is single-flight; 401/403 trigger one refresh;
 * 429 honors x-rate-limit-retry-after-seconds.
 */
export class PpubsClient {
  private session: PpubsSession | null = null;
  private sessionPromise: Promise<PpubsSession> | null = null;
  private readonly rateLimiter = new TokenBucketRateLimiter({ intervalMs: 1000 });

  async getSession(): Promise<PpubsSession> {
    if (this.session && Date.now() < this.session.expiresAt) {
      return this.session;
    }
    if (!this.sessionPromise) {
      this.sessionPromise = this.establishSession()
        .finally(() => { this.sessionPromise = null; });
    }
    return this.sessionPromise;
  }

  private async establishSession(): Promise<PpubsSession> {
    const { data, error } = await fetchWithTimeout(async (signal) => {
      const resp = await fetch(`${PPUBS_BASE}/api/users/me/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Token': 'null',
          'Referer': REFERER,
          'User-Agent': USER_AGENT,
        },
        body: '-1',
        signal,
      });
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      return { status: resp.status, headers, text: await resp.text() };
    }, 15000);

    if (error || !data || data.status !== 200) {
      const detail = error || (data ? `HTTP ${data.status}` : 'unknown');
      throw new Error(`USPTO Public Search session establishment failed (${detail}). The service may be temporarily unavailable.`);
    }

    let parsed: { userCase?: { caseId?: number } };
    try {
      parsed = JSON.parse(data.text);
    } catch {
      throw new Error('USPTO Public Search session returned malformed JSON.');
    }
    const caseId = parsed.userCase?.caseId;
    const token = data.headers['x-access-token'];
    if (!caseId || !token) {
      throw new Error('USPTO Public Search session response missing caseId or access token.');
    }
    this.session = { token, caseId, expiresAt: Date.now() + SESSION_TTL_MS };
    return this.session;
  }

  private async rawRequest(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: string; sessionRetried?: boolean; rateRetried?: boolean }
  ): Promise<PpubsResponse> {
    await this.rateLimiter.acquire();
    const session = await this.getSession();

    const { data, error } = await fetchWithTimeout(async (signal) => {
      const resp = await fetch(`${PPUBS_BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Token': session.token,
          'Referer': REFERER,
          'User-Agent': USER_AGENT,
        },
        body: init.body,
        signal,
      });
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      return { status: resp.status, headers, body: await resp.text() };
    }, 30000);

    if (error) {
      throw new Error(`USPTO Public Search request failed: ${error}`);
    }
    if (!data) {
      throw new Error('USPTO Public Search request returned no data.');
    }

    // Session expiry (observed as both 401 and 403) → refresh once and retry.
    if ((data.status === 401 || data.status === 403) && !init.sessionRetried) {
      this.session = null;
      const fresh = await this.getSession();
      let body = init.body;
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed?.query && typeof parsed.query === 'object') {
            parsed.query.caseId = fresh.caseId;
            body = JSON.stringify(parsed);
          }
        } catch {
          // Non-JSON body: retry with it unchanged rather than dropping it.
        }
      }
      return this.rawRequest(method, path, { body, sessionRetried: true, rateRetried: init.rateRetried });
    }

    if (data.status === 429 && !init.rateRetried) {
      const waitMs = Number(data.headers['x-rate-limit-retry-after-seconds'] || '5') * 1000;
      await new Promise(r => setTimeout(r, Math.min(waitMs, 30000)));
      return this.rawRequest(method, path, { body: init.body, sessionRetried: init.sessionRetried, rateRetried: true });
    }

    return data;
  }

  /**
   * Run a PPUBS search. `q` uses PPUBS field syntax (e.g. `crispr AND
   * (pfizer).as.`). `databases` defaults to applications + grants + OCR.
   * `sort` is a required upstream body key — verified values are
   * `'score desc'` (relevance) and `'date_publ desc'` (recency; default).
   */
  async search(q: string, options: { start?: number; pageCount?: number; databases?: string[]; sort?: string } = {}): Promise<PpubsResponse> {
    const session = await this.getSession();
    const body = searchBody(
      session.caseId,
      q,
      options.start ?? 0,
      Math.min(options.pageCount ?? 10, 100),
      options.databases ?? ['US-PGPUB', 'USPAT', 'USOCR'],
      options.sort ?? 'date_publ desc',
    );
    return this.rawRequest('POST', '/api/searches/searchWithBeFamily', { body: JSON.stringify(body) });
  }

  /** Fetch the full document record for a search-result guid. */
  async getDocument(guid: string, sourceType: string): Promise<PpubsResponse> {
    return this.rawRequest(
      'GET',
      `/api/patents/highlight/${encodeURIComponent(guid)}?queryId=1&source=${encodeURIComponent(sourceType)}&includeSections=true&uniqueId=`,
      {},
    );
  }

  close(): void {
    this.session = null;
    this.sessionPromise = null;
  }
}

export const ppubsClient = new PpubsClient();

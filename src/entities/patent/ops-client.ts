import { TokenBucketRateLimiter } from '../../connections/rate-limiter.js';
import { fetchWithTimeout } from '../../connections/fetch-utils.js';
import { HttpConnectionError } from '../../connections/errors.js';

const OPS_BASE = 'https://ops.epo.org/3.2';
const TOKEN_TTL_MS = 18 * 60 * 1000;

const OPS_BACKOFF_MS = 15 * 60 * 1000;
const OPS_CONSECUTIVE_FAILURES = 2;

export function hasOpsCredentials(): boolean {
  return !!(process.env.EPO_OPS_CONSUMER_KEY && process.env.EPO_OPS_CONSUMER_SECRET);
}

/**
 * Auto-mode failure memory for OPS (mirrors the Google Patents breaker).
 * Placeholder/expired credentials or quota exhaustion otherwise burn a
 * failed call on every federated search. 2 consecutive failures — or any
 * auth-class failure (401/403/quota/invalid credentials), which never
 * self-heal — exclude OPS from auto selection for 15 minutes. Any success
 * resets the counter. Explicit `source: 'ops'` bypasses the backoff.
 */
const opsBackoff: { failures: number; excludedUntil: number; lastReason?: string } = {
  failures: 0,
  excludedUntil: 0,
};

export function isOpsBackedOff(): boolean {
  return Date.now() < opsBackoff.excludedUntil;
}

export function opsBackoffReason(): string | undefined {
  return isOpsBackedOff() ? opsBackoff.lastReason : undefined;
}

export function resetOpsBackoff(): void {
  opsBackoff.failures = 0;
  opsBackoff.excludedUntil = 0;
  opsBackoff.lastReason = undefined;
}

const AUTH_FAILURE_RE = /HTTP 40[13]|quota|invalid credential|EPO_OPS_CONSUMER/i;

export function recordOpsFailure(message: string): void {
  opsBackoff.lastReason = message.slice(0, 200);
  if (AUTH_FAILURE_RE.test(message)) {
    opsBackoff.failures = OPS_CONSECUTIVE_FAILURES;
  } else {
    opsBackoff.failures++;
  }
  if (opsBackoff.failures >= OPS_CONSECUTIVE_FAILURES) {
    opsBackoff.excludedUntil = Date.now() + OPS_BACKOFF_MS;
  }
}

export function recordOpsSuccess(): void {
  if (opsBackoff.failures > 0 || opsBackoff.excludedUntil > 0) resetOpsBackoff();
}

interface TokenState {
  token: string;
  expiresAt: number;
}

interface OpsResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Session client for the EPO Open Patent Services (OPS) API.
 *
 * OPS uses OAuth2 client-credentials auth with ~20-minute tokens, which does
 * not fit the static registry AuthConfig, so this client is entity-managed.
 * Throttling on OPS manifests as HTTP 403 with an X-Rejection-Reason header
 * (and occasionally HTTP 429); `get()` branches on the rejection reason.
 */
export class OpsClient {
  private tokenState: TokenState | null = null;
  private tokenPromise: Promise<string> | null = null;
  private readonly rateLimiter = new TokenBucketRateLimiter({ intervalMs: 1000 });

  async getToken(): Promise<string> {
    if (this.tokenState && Date.now() < this.tokenState.expiresAt) {
      return this.tokenState.token;
    }
    if (!this.tokenPromise) {
      this.tokenPromise = this.fetchToken()
        .finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const key = process.env.EPO_OPS_CONSUMER_KEY || '';
    const secret = process.env.EPO_OPS_CONSUMER_SECRET || '';
    const basic = Buffer.from(`${key}:${secret}`).toString('base64');
    const { data, error } = await fetchWithTimeout(async (signal) => {
      const resp = await fetch(`${OPS_BASE}/auth/accesstoken`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal,
      });
      return {
        status: resp.status,
        text: await resp.text(),
      };
    }, 15000);

    if (error || !data || data.status !== 200) {
      const detail = error || (data ? `HTTP ${data.status}: ${data.text.slice(0, 200)}` : 'unknown');
      // Auth failures never self-heal — trip the auto-mode backoff from ANY
      // call site (search chains and detail chains alike).
      recordOpsFailure(`EPO OPS authentication failed (${detail})`);
      throw new Error(`EPO OPS authentication failed. Verify EPO_OPS_CONSUMER_KEY / EPO_OPS_CONSUMER_SECRET. (${detail})`);
    }

    let parsed: { access_token?: string; expires_in?: number };
    try {
      parsed = JSON.parse(data.text);
    } catch {
      throw new Error(`EPO OPS authentication returned malformed response: ${data.text.slice(0, 200)}`);
    }
    if (!parsed.access_token) {
      throw new Error('EPO OPS authentication returned no access_token.');
    }
    const ttlMs = Math.max(60_000, (parsed.expires_in || 1199) * 1000 - 120_000);
    this.tokenState = { token: parsed.access_token, expiresAt: Date.now() + Math.min(ttlMs, TOKEN_TTL_MS) };
    return parsed.access_token;
  }

  /**
   * GET a /rest-services path with auth + retry on OPS-style throttling
   * (403 with an X-Rejection-Reason rate-limit header, or HTTP 429).
   * Transient rate limits (reason containing "RateLimit", or 429) are
   * retried once after a backoff; quota-class rejections are not retried —
   * they record an auto-mode failure and throw. Returns raw text.
   */
  async get(path: string, timeoutMs = 20000): Promise<OpsResponse> {
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      await this.rateLimiter.acquire();
      const token = await this.getToken();
      const { data, error } = await fetchWithTimeout(async (signal) => {
        const resp = await fetch(`${OPS_BASE}/rest-services${path}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
          },
          signal,
        });
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        return {
          status: resp.status,
          headers,
          body: await resp.text(),
        };
      }, timeoutMs);

      if (error) {
        lastError = `EPO OPS request failed: ${error}`;
        continue;
      }
      if (!data) {
        lastError = 'EPO OPS request returned no data.';
        continue;
      }

      const rejection = data.headers['x-rejection-reason'] || data.headers['X-Rejection-Reason'];
      const throttled = data.status === 429 || (data.status === 403 && !!rejection);
      if (throttled) {
        const reason = rejection || 'rate limit exceeded';
        const transient = data.status === 429 || /RateLimit/i.test(reason);
        if (transient && attempt === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        const message = transient
          ? `EPO OPS rate limited (${reason}); still throttled after retry`
          : `EPO OPS quota rejection: ${reason} (retry will not help until the quota window resets)`;
        recordOpsFailure(message);
        throw new HttpConnectionError(message, data.status, false);
      }
      return data;
    }
    throw new Error(lastError || 'EPO OPS request failed after retry.');
  }

  close(): void {
    this.tokenState = null;
    this.tokenPromise = null;
  }
}

export const opsClient = new OpsClient();

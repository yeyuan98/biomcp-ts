import { TokenBucketRateLimiter } from '../../connections/rate-limiter.js';
import { fetchWithTimeout } from '../../connections/fetch-utils.js';

const OPS_BASE = 'https://ops.epo.org/3.2';
const TOKEN_TTL_MS = 18 * 60 * 1000;

export function hasOpsCredentials(): boolean {
  return !!(process.env.EPO_OPS_CONSUMER_KEY && process.env.EPO_OPS_CONSUMER_SECRET);
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
 * (not 429), so retry logic keys on that header.
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
   * (403 + X-Rejection-Reason quota headers). Returns raw text.
   */
  async get(path: string, timeoutMs = 20000): Promise<OpsResponse> {
    await this.rateLimiter.acquire();
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
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
      if (data.status === 403 && rejection && attempt === 0) {
        // OPS throttling: back off once and retry.
        await new Promise(r => setTimeout(r, 2000));
        continue;
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

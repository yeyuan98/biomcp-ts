import {
  IConnection,
  ConnectionOptions,
  ConnectionHandling,
  ProtocolType
} from './base.js';
import { VERSION } from '../version.js';
import { TokenBucketRateLimiter, RateLimiterFactory } from './rate-limiter.js';
import { withRetry, isRetryableError } from './retry.js';
import { HttpConnectionError } from './errors.js';

/**
 * Wrap transport-level fetch rejections (DNS failure, refused sockets,
 * timeouts below the abort threshold) in a typed `HttpConnectionError` with
 * `status` undefined (retryable) instead of letting a raw
 * `TypeError: fetch failed` escape with its real signal (`ECONNREFUSED`,
 * `ETIMEDOUT`, …) buried in `cause.code`. The original error is preserved
 * verbatim as `.cause`, and its message is kept as-is — with
 * ` (<cause code>)` appended only when a code exists, so string-matching
 * consumers (`fetch failed`) keep working and messages never degrade to
 * `fetch failed (undefined)`.
 *
 * Classification gates:
 * - Abort/timeout rejections (caller cancellation via AbortSignal, or the
 *   15 s `AbortSignal.timeout`) are NOT wrapped: callers pin their current
 *   observable shape — `name === 'AbortError'/'TimeoutError'` (geneGet) and
 *   the `/abort|timeout/` message matchers (cross-entity, server/errors,
 *   fetch-utils) — so they propagate untouched, exactly as before.
 * - Only rejections the retry layer already classifies as network failures
 *   (message / `cause.code` signature — every real-world Node fetch
 *   rejection, `TypeError: fetch failed`, matches) are wrapped. Messages
 *   without a network signature keep today's raw escape and
 *   non-retryable classification, so retry counts — and the real-backoff
 *   timings callers budget for — are unchanged.
 */
function wrapTransportError(error: unknown): unknown {
  if (error instanceof HttpConnectionError) return error;
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return error;
  if (!isRetryableError(error)) return error;
  const original = error as Error;
  const code = (original.cause as { code?: string } | undefined)?.code;
  const wrapped = new HttpConnectionError(code ? `${original.message} (${code})` : original.message);
  wrapped.cause = original;
  return wrapped;
}

function getHttpStatusHint(status: number, sourceId: string): string {
  if (status === 400) {
    return ` — The request was rejected by ${sourceId}. The record may not exist or may not be indexed yet. Verify the ID is correct and try an older/established record.`;
  }
  if (status === 404) {
    return ` — Resource not found at ${sourceId}. The record may not exist or has been removed. Verify the ID.`;
  }
  if (status === 429) {
    return ` — Rate limited by ${sourceId}. Wait a few seconds and retry. If this persists, set the ${sourceId} API key in environment variables for higher rate limits.`;
  }
  if (status === 401 || status === 403) {
    return ` — Authentication required or forbidden by ${sourceId}. Set the required API key in environment variables.`;
  }
  if (status >= 500) {
    return ` — Server error from ${sourceId}. The service may be temporarily unavailable. Try again later.`;
  }
  return '';
}

export class RestConnection implements IConnection<string, unknown> {
  readonly sourceId: string;
  readonly protocol: ProtocolType = 'rest';
  readonly effectiveRateLimitMs: number;
  
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly handling: ConnectionHandling;
  private readonly hasAuth: boolean;
  
  constructor(
    private readonly options: ConnectionOptions
  ) {
    this.sourceId = options.sourceId;
    this.handling = options.handling || {};
    this.hasAuth = !!options.auth?.envVar && !!process.env[options.auth.envVar];
    
    this.rateLimiter = RateLimiterFactory.create(options.rateLimit, this.hasAuth);
    this.effectiveRateLimitMs = RateLimiterFactory.getEffectiveRate(
      options.rateLimit.intervalMs,
      options.rateLimit,
      this.hasAuth
    );
  }
  
  async request(path: string, _variables?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.withSourceRetry(() => this.requestOnce(path, options));
  }

  private async requestOnce(path: string, options?: { signal?: AbortSignal }): Promise<unknown> {
    await this.rateLimiter.acquire();

    const url = this.buildUrl(path);
    const headers = this.buildHeaders();

    const signals: AbortSignal[] = [];
    if (this.handling.timeoutMs) signals.push(AbortSignal.timeout(this.handling.timeoutMs));
    if (options?.signal) signals.push(options.signal);
    const signal = signals.length > 0 ? (signals.length === 1 ? signals[0] : AbortSignal.any(signals)) : undefined;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal,
        redirect: this.options.followRedirects === false ? 'manual' : 'follow',
      });
    } catch (error) {
      throw wrapTransportError(error);
    }
    
    if (!response.ok) {
      if (this.options.followRedirects === false) {
        this.throwIfUnexpectedRedirect(response, url);
      }
      const hint = getHttpStatusHint(response.status, this.sourceId);
      throw new HttpConnectionError(`HTTP ${response.status}: ${response.statusText} — URL: ${url} — Source: ${this.sourceId}${hint}`, response.status);
    }
    
    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType || contentType.includes('json')) {
      return this.parseJsonBody(response);
    }
    return response.text();
  }

  /**
   * Parse a JSON response body with a raw-control-character fallback.
   *
   * Some sources intermittently serve JSON containing raw (unescaped)
   * U+0000–U+001F control characters inside string literals — forbidden by
   * RFC 8259 and rejected by V8 with an opaque `SyntaxError: Bad control
   * character in string literal` (observed live from NCBI via
   * genbank_search). When the strict parse throws a SyntaxError, the payload
   * is retried once with every raw control character REMOVED. Removal
   * (rather than escaping) is deliberate: an escaped `\uXXXX` form is only
   * valid inside a string, and without a full tokenizer the fallback cannot
   * tell string content from inter-token whitespace; dropping the byte is
   * lossy only for that single character and can never alter document
   * structure (outside string literals these bytes are insignificant JSON
   * whitespace). Payloads that parse strictly are byte-untouched — the
   * fallback only runs after a failure — and if the sanitized payload still
   * fails to parse, the ORIGINAL SyntaxError propagates so the genuine
   * defect stays visible.
   *
   * Mechanics: the response is cloned BEFORE the primary parse because a
   * failed `response.json()` leaves the body stream consumed ("Body is
   * unusable"), leaving no second chance at the bytes. Minimal response
   * stand-ins without the stream API (as used throughout the test suite)
   * skip the clone and keep today's `response.json()` verbatim behavior,
   * mirroring the defensive `headers?.get?.` access above.
   */
  private async parseJsonBody(response: Response): Promise<unknown> {
    let backup: Response | undefined;
    try {
      if (typeof response.clone === 'function') backup = response.clone();
    } catch {
      // Cloning only fails on an already-disturbed body, which the primary
      // parse below would reject anyway; proceed without the fallback copy.
    }
    try {
      return await response.json();
    } catch (error) {
      // Name check alongside instanceof: the rejection may cross realm
      // boundaries (undici under Jest's vm), where instanceof fails but the
      // `name` property still reads "SyntaxError".
      const isSyntaxError = error instanceof SyntaxError ||
        (error as { name?: unknown } | null)?.name === 'SyntaxError';
      if (!isSyntaxError || !backup) throw error;
      const sanitized = (await backup.text()).replace(/[\x00-\x1f]/g, '');
      try {
        return JSON.parse(sanitized);
      } catch {
        throw error; // propagate the ORIGINAL error, not the sanitized one
      }
    }
  }

  /** `body` may be a plain string — sent verbatim as text/plain (e.g. Reactome
   *  AnalysisService identifier posts); objects are sent as JSON. */
  async post(path: string, body: Record<string, unknown> | string, options?: { signal?: AbortSignal }): Promise<unknown> {
    return this.withSourceRetry(() => this.postOnce(path, body, options));
  }

  private async postOnce(path: string, body: Record<string, unknown> | string, options?: { signal?: AbortSignal }): Promise<unknown> {
    await this.rateLimiter.acquire();

    const url = this.buildUrl(path);
    const headers = this.buildHeaders();
    headers.set('Content-Type', typeof body === 'string' ? 'text/plain' : 'application/json');

    const signals: AbortSignal[] = [];
    if (this.handling.timeoutMs) signals.push(AbortSignal.timeout(this.handling.timeoutMs));
    if (options?.signal) signals.push(options.signal);
    const signal = signals.length > 0 ? (signals.length === 1 ? signals[0] : AbortSignal.any(signals)) : undefined;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal,
        redirect: this.options.followRedirects === false ? 'manual' : 'follow',
      });
    } catch (error) {
      throw wrapTransportError(error);
    }

    if (response.status === 204) return null;

    if (!response.ok) {
      if (this.options.followRedirects === false) {
        this.throwIfUnexpectedRedirect(response, url);
      }
      const hint = getHttpStatusHint(response.status, this.sourceId);
      throw new HttpConnectionError(`HTTP ${response.status}: ${response.statusText} — URL: ${url} — Source: ${this.sourceId}${hint}`, response.status);
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType || contentType.includes('json')) {
      return this.parseJsonBody(response);
    }
    return response.text();
  }

  async batch(paths: string[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const path of paths) {
      results.push(await this.request(path));
    }
    return results;
  }
  
  async healthCheck(): Promise<boolean> {
    try {
      await fetch(this.options.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return true;
    } catch {
      return false;
    }
  }
  
  close(): void {
    // No persistent connections to close for fetch-based client
  }
  
  private withSourceRetry<T>(fn: () => Promise<T>): Promise<T> {
    const retry = this.options.retry;
    if (!retry) {
      return fn();
    }
    return withRetry(fn, {
      maxRetries: Math.max((retry.attempts ?? 2) - 1, 0),
      baseDelayMs: retry.backoffMs ?? 1000,
      logger: { warn: (msg: string) => console.warn(`[${this.sourceId}] ${msg}`) },
    });
  }

  private throwIfUnexpectedRedirect(response: Response, url: string): void {
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      throw new HttpConnectionError(
        `Unexpected redirect (HTTP ${response.status}) from ${this.sourceId}${location ? ` — Location: ${location}` : ''} — URL: ${url}`,
        response.status
      );
    }
  }
  
  private buildUrl(path: string, query?: Record<string, string>): string {
    // Query-string-only paths (`?id=…`) attach directly to the endpoint URL:
    // inserting a path separator would produce `file.cgi/?id=…`, which strict
    // endpoints reject with 404.
    const queryOnly = path.startsWith('?') || path.startsWith('#');
    let base = this.options.baseUrl;
    if (queryOnly) {
      if (base.endsWith('/')) {
        base = base.slice(0, -1);
      }
    } else if (!base.endsWith('/')) {
      base += '/';
    }
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const rawUrl = base + normalizedPath;
    const url = new URL(rawUrl);
    
    if (query) {
      Object.entries(query).forEach(([k, v]) => {
        url.searchParams.set(k, v);
      });
    }
    
    if (this.options.auth?.delivery.type === 'query-param' && this.hasAuth) {
      url.searchParams.set(
        this.options.auth.delivery.name,
        process.env[this.options.auth.envVar] || ''
      );
    }

    for (const group of this.handling.envQueryParams ?? []) {
      if (!process.env[group.envVar]) continue;
      for (const [name, value] of Object.entries(group.params)) {
        const resolved = value.startsWith('$') ? (process.env[value.slice(1)] || '') : value;
        if (resolved) url.searchParams.set(name, resolved);
      }
    }

    return url.toString();
  }
  
  private buildHeaders(): Headers {
    const headers = new Headers();

    // Some APIs (e.g. OpenTargets) reject Node's implicit `user-agent: node`
    // at their edge; send an identifying UA unless the source overrides it.
    headers.set('User-Agent', `biomcp-ts/${VERSION}`);

    const acceptMap: Record<string, string> = {
      json: 'application/json',
      xml: 'text/xml, application/xml',
      text: 'text/plain',
      binary: 'application/octet-stream',
    };
    const accept = this.handling.contentType
      ? acceptMap[this.handling.contentType] || 'application/json'
      : 'application/json';
    headers.set('Accept', accept);

    if (this.handling.headers) {
      for (const [name, value] of Object.entries(this.handling.headers)) {
        headers.set(name, value);
      }
    }

    if (!this.options.auth || !this.hasAuth) {
      return headers;
    }
    
    const delivery = this.options.auth.delivery;
    
    if (delivery.type === 'header') {
      headers.set(delivery.name, process.env[this.options.auth.envVar] || '');
    }
    
    if (delivery.type === 'bearer') {
      headers.set('Authorization', `Bearer ${process.env[this.options.auth.envVar]}`);
    }
    
    if (delivery.type === 'authorization') {
      const prefix = delivery.prefix ? `${delivery.prefix} ` : '';
      headers.set('Authorization', `${prefix}${process.env[this.options.auth.envVar]}`);
    }
    
    return headers;
  }
}
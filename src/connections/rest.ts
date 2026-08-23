import {
  IConnection,
  ConnectionOptions,
  ConnectionHandling,
  ProtocolType
} from './base.js';
import { TokenBucketRateLimiter, RateLimiterFactory } from './rate-limiter.js';
import { withRetry } from './retry.js';
import { HttpConnectionError } from './errors.js';

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

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal,
      redirect: this.options.followRedirects === false ? 'manual' : 'follow',
    });
    
    if (!response.ok) {
      if (this.options.followRedirects === false) {
        this.throwIfUnexpectedRedirect(response, url);
      }
      const hint = getHttpStatusHint(response.status, this.sourceId);
      throw new HttpConnectionError(`HTTP ${response.status}: ${response.statusText} — URL: ${url} — Source: ${this.sourceId}${hint}`, response.status);
    }
    
    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType || contentType.includes('json')) {
      return response.json();
    }
    return response.text();
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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal,
      redirect: this.options.followRedirects === false ? 'manual' : 'follow',
    });

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
      return response.json();
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
    let base = this.options.baseUrl;
    if (!base.endsWith('/')) {
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
        url.searchParams.set(name, value.startsWith('$') ? (process.env[value.slice(1)] || '') : value);
      }
    }

    return url.toString();
  }
  
  private buildHeaders(): Headers {
    const headers = new Headers();

    // Some APIs (e.g. OpenTargets) reject Node's implicit `user-agent: node`
    // at their edge; send an identifying UA unless the source overrides it.
    headers.set('User-Agent', 'biomcp-ts/0.2.3');

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
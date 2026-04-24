import { 
  IConnection, 
  ConnectionOptions, 
  ConnectionHandling,
  ProtocolType 
} from './base.js';
import { TokenBucketRateLimiter, RateLimiterFactory } from './rate-limiter.js';

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
  
  async request(path: string): Promise<unknown> {
    await this.rateLimiter.acquire();
    
    const url = this.buildUrl(path);
    const headers = this.buildHeaders();
    
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: this.handling.timeoutMs 
        ? AbortSignal.timeout(this.handling.timeoutMs) 
        : undefined,
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} — URL: ${url} — Source: ${this.sourceId}`);
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
    
    return url.toString();
  }
  
  private buildHeaders(): Headers {
    const headers = new Headers();
    
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
      headers.set('Authorization', `${delivery.prefix || 'app_key '}${process.env[this.options.auth.envVar]}`);
    }
    
    return headers;
  }
}
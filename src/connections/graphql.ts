import { 
  IConnection, 
  ConnectionOptions, 
  AuthConfig, 
  ProtocolType 
} from './base.js';
import { TokenBucketRateLimiter, RateLimiterFactory } from './rate-limiter.js';

export class GraphQLConnection implements IConnection<string, unknown> {
  readonly sourceId: string;
  readonly protocol: ProtocolType = 'graphql';
  effectiveRateLimitMs: number;
  
  private readonly rateLimiter: TokenBucketRateLimiter;
  
  constructor(
    private readonly options: ConnectionOptions,
    private readonly auth?: AuthConfig
  ) {
    this.sourceId = options.sourceId;
    const hasAuth = !!auth?.envVar && !!process.env[auth.envVar];
    
    this.rateLimiter = RateLimiterFactory.create(options.rateLimit, hasAuth);
    this.effectiveRateLimitMs = RateLimiterFactory.getEffectiveRate(
      options.rateLimit.intervalMs,
      options.rateLimit,
      hasAuth
    );
  }
  
  async request(query: string, variables?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> {
    await this.rateLimiter.acquire();

    const body: Record<string, unknown> = { query };
    if (variables) {
      body.variables = variables;
    }

    const signals: AbortSignal[] = [];
    const timeoutMs = this.options.handling?.timeoutMs || 15000;
    signals.push(AbortSignal.timeout(timeoutMs));
    if (options?.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    const response = await fetch(this.options.baseUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  async batch(queries: string[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const query of queries) {
      results.push(await this.request(query));
    }
    return results;
  }
  
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(this.options.baseUrl, { method: 'POST', signal: AbortSignal.timeout(5000) });
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }
  
  close(): void {
    // No persistent connections
  }
  
  private buildHeaders(): Headers {
    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    
    if (!this.auth || !process.env[this.auth.envVar]) {
      return headers;
    }
    
    const delivery = this.auth.delivery;
    
    if (delivery.type === 'header') {
      headers.set(delivery.name, process.env[this.auth.envVar] || '');
    }
    
    if (delivery.type === 'bearer') {
      headers.set('Authorization', `Bearer ${process.env[this.auth.envVar]}`);
    }
    
    return headers;
  }
}
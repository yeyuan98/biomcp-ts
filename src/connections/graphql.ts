import { 
  IConnection, 
  ConnectionOptions, 
  AuthConfig, 
  ProtocolType 
} from './base.js';
import { TokenBucketRateLimiter, RateLimiterFactory } from './rate-limiter.js';
import { withRetry } from './retry.js';
import { HttpConnectionError } from './errors.js';

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
  
  /**
   * Execute a GraphQL query. When `rootField` is provided and the response
   * carries errors, a null/missing `data[rootField]` throws (GraphQL APIs
   * legitimately return partial data + errors, so only the requested field
   * gates). Without `rootField`, only a nullish `data` alongside errors
   * throws; partial data is returned as-is.
   */
  async request(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal; rootField?: string }
  ): Promise<unknown> {
    const retry = this.options.retry;
    const fn = () => this.requestOnce(query, variables, options);
    if (!retry) {
      return fn();
    }
    return withRetry(fn, {
      maxRetries: Math.max((retry.attempts ?? 2) - 1, 0),
      baseDelayMs: retry.backoffMs ?? 1000,
      logger: { warn: (msg: string) => console.warn(`[${this.sourceId}] ${msg}`) },
    });
  }

  private async requestOnce(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal; rootField?: string }
  ): Promise<unknown> {
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
      throw new HttpConnectionError(
        `HTTP ${response.status}: ${response.statusText} — URL: ${this.options.baseUrl} — Source: ${this.sourceId}`,
        response.status
      );
    }
    
    const payload = await response.json() as {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message?: string }>;
    };
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) {
      const firstMessage = errors[0]?.message ?? 'unknown GraphQL error';
      if (payload.data == null) {
        throw new HttpConnectionError(`GraphQL error from ${this.sourceId}: ${firstMessage}`, undefined, false);
      }
      if (options?.rootField && payload.data[options.rootField] == null) {
        throw new HttpConnectionError(
          `GraphQL error from ${this.sourceId}: root field '${options.rootField}' is null/missing: ${firstMessage}`,
          undefined,
          false
        );
      }
    }
    return payload;
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
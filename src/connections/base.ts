export type ProtocolType = 'rest' | 'graphql' | 'grpc';

export type AuthDeliveryMethod =
  | { type: 'header'; name: string }
  | { type: 'bearer' }
  | { type: 'authorization'; prefix?: string }
  | { type: 'query-param'; name: string }
  | { type: 'grpc-metadata'; name: string };

export interface AuthConfig {
  envVar: string;
  required: boolean;
  delivery: AuthDeliveryMethod;
  fallbackRateLimitMs?: number;
  keyedRateLimitMs?: number;
}

export interface RateLimitConfig {
  intervalMs: number;
  conditional?: boolean;
  fallbackRateLimitMs?: number;
  keyedRateLimitMs?: number;
}

export interface ConnectionHandling {
  streaming?: boolean;
  timeoutMs?: number;
  batchable?: boolean;
  maxBatchSize?: number;
  contentType?: 'json' | 'xml' | 'text' | 'binary';
  staleHours?: number;
  headers?: Record<string, string>;
}

export interface RetryConfig {
  /**
   * Total tries per request (initial attempt + retries).
   * @default 2
   */
  attempts?: number;
  /**
   * Base backoff delay in ms before the first retry; doubles per retry.
   * @default 1000
   */
  backoffMs?: number;
}

export interface ConnectionOptions {
  sourceId: string;
  baseUrl: string;
  protocol: ProtocolType;
  auth?: AuthConfig;
  rateLimit: RateLimitConfig;
  handling?: ConnectionHandling;
  followRedirects?: boolean;
  /**
   * Connection-layer retry policy. Absent = single attempt (no retry);
   * only retryable failures (network errors, 429, 5xx) are retried.
   */
  retry?: RetryConfig;
}

export interface IConnection<TRequest = string, TResponse = unknown> {
  readonly sourceId: string;
  readonly protocol: ProtocolType;
  effectiveRateLimitMs: number;
  
  request(req: TRequest, variables?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<TResponse>;
  post?(path: string, body: Record<string, unknown> | string, options?: { signal?: AbortSignal }): Promise<TResponse>;
  batch?(requests: TRequest[]): Promise<TResponse[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}

export type AnyConnection = IConnection;
export type ProtocolType = 'rest' | 'graphql';

export type AuthDeliveryMethod =
  | { type: 'header'; name: string }
  | { type: 'bearer' }
  | { type: 'authorization'; prefix?: string }
  | { type: 'query-param'; name: string };

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
  /**
   * Query params appended to every request, but only while the referenced
   * env var is set (e.g. NCBI E-utilities tool/email identification). A
   * param value of the form '$ENV_VAR' resolves to that env var's value.
   */
  envQueryParams?: Array<{ envVar: string; params: Record<string, string> }>;
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
  /**
   * Total wall-clock budget (ms) per logical request — all attempts plus
   * backoff delays. When the next retry is projected to exceed it, the last
   * error is rethrown (with a 'retry budget exhausted' note appended; type
   * unchanged). Caps retry amplification (#107): attempts × timeoutMs must
   * not stack into a minutes-long request. Unset = no budget (legacy
   * behavior). Size it to always allow one full attempt (timeoutMs + one
   * backoff).
   */
  retryBudgetMs?: number;
  /**
   * Max simultaneous in-flight fetch attempts against this source, enforced
   * by a per-source FIFO semaphore acquired around each attempt (backoffs
   * wait outside). Caps fan-out pileup when parallel tool calls hit one
   * upstream (#107). Unset = unlimited (legacy behavior).
   */
  concurrency?: number;
}

export interface IConnection<TRequest = string, TResponse = unknown> {
  readonly sourceId: string;
  readonly protocol: ProtocolType;
  effectiveRateLimitMs: number;
  
  request(req: TRequest, variables?: Record<string, unknown>, options?: { signal?: AbortSignal; rootField?: string }): Promise<TResponse>;
  post?(path: string, body: Record<string, unknown> | string, options?: { signal?: AbortSignal }): Promise<TResponse>;
  batch?(requests: TRequest[]): Promise<TResponse[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}

export type AnyConnection = IConnection;
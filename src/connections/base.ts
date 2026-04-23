export type ProtocolType = 'rest' | 'graphql' | 'grpc' | 'local-file';

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
}

export interface ConnectionOptions {
  sourceId: string;
  baseUrl: string;
  protocol: ProtocolType;
  auth?: AuthConfig;
  rateLimit: RateLimitConfig;
  handling?: ConnectionHandling;
}

export interface IConnection<TRequest = string, TResponse = unknown> {
  readonly sourceId: string;
  readonly protocol: ProtocolType;
  effectiveRateLimitMs: number;
  
  request(req: TRequest, variables?: Record<string, unknown>): Promise<TResponse>;
  batch?(requests: TRequest[]): Promise<TResponse[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}

export type AnyConnection = IConnection;
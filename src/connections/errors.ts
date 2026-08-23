/**
 * Typed HTTP failure thrown by connection-layer transports.
 *
 * `status` is undefined for transport-level failures (fetch rejected before
 * a response arrived). `retryable` classifies transient failures: network
 * errors (no status), 429 rate limits, and 5xx server errors. Deterministic
 * application-level failures (e.g. GraphQL `errors[]` on a 200) pass
 * `retryable: false` explicitly.
 */
export class HttpConnectionError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable?: boolean) {
    super(message);
    this.name = 'HttpConnectionError';
    this.status = status;
    this.retryable = retryable ?? (status === undefined || status === 429 || status >= 500);
  }
}

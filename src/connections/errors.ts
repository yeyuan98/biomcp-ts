/**
 * Typed HTTP failure thrown by connection-layer transports.
 *
 * `status` is undefined for transport-level failures (fetch rejected before
 * a response arrived). `retryable` classifies transient failures: network
 * errors (no status), 429 rate limits, and 5xx server errors.
 */
export class HttpConnectionError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpConnectionError';
    this.status = status;
    this.retryable = status === undefined || status === 429 || status >= 500;
  }
}

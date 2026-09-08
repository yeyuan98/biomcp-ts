import { appendFile, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HttpTraceRecord {
  type: 'http_request';
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  clientLabel: string;
  clientIp?: string;
  sessionId?: string;
}

export interface ToolTraceRecord {
  type: 'tool_call';
  timestamp: string;
  tool: string;
  sessionId?: string;
  clientLabel: string;
  durationMs: number;
  status: 'success' | 'error';
  inputArgs?: Record<string, unknown>;
  error?: string;
}

export type TraceRecord = HttpTraceRecord | ToolTraceRecord;

const SENSITIVE_KEY_PATTERN = /token|key|secret|password|auth/i;
const MAX_STRING_LENGTH = 512;

export function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return `[Truncated: ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 20) {
      return `[Array with ${value.length} items truncated]`;
    }
    return value.map(sanitizeValue);
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = sanitizeValue(v);
      }
    }
    return sanitized;
  }
  return value;
}

export class Tracer {
  private readonly enabled: boolean;
  private readonly filePath: string;
  private dirEnsured = false;

  constructor(options?: { enabled?: boolean; filePath?: string }) {
    this.enabled = options?.enabled ?? false;
    this.filePath = options?.filePath ?? 'biomcp-traces.jsonl';
  }

  record(record: TraceRecord): void {
    if (!this.enabled) return;

    if (!this.dirEnsured) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.dirEnsured = true;
      } catch {
        // Ignore directory creation error
      }
    }

    let line: string;
    try {
      line = JSON.stringify(record) + '\n';
    } catch {
      // If serialization fails (e.g. unexpected circular reference), drop trace safely
      return;
    }
    appendFile(this.filePath, line, (err) => {
      if (err) {
        // Silently drop trace write error to never impact service availability
      }
    });
  }

  recordHttp(
    method: string,
    path: string,
    status: number,
    durationMs: number,
    clientLabel: string,
    clientIp?: string,
    sessionId?: string,
  ): void {
    if (!this.enabled) return;
    this.record({
      type: 'http_request',
      timestamp: new Date().toISOString(),
      method,
      path,
      status,
      durationMs: Math.round(durationMs),
      clientLabel,
      clientIp,
      sessionId,
    });
  }

  recordTool(
    tool: string,
    durationMs: number,
    status: 'success' | 'error',
    clientLabel: string,
    sessionId?: string,
    args?: Record<string, unknown>,
    error?: string,
  ): void {
    if (!this.enabled) return;
    this.record({
      type: 'tool_call',
      timestamp: new Date().toISOString(),
      tool,
      sessionId,
      clientLabel,
      durationMs: Math.round(durationMs),
      status,
      inputArgs: args ? (sanitizeValue(args) as Record<string, unknown>) : undefined,
      error,
    });
  }
}

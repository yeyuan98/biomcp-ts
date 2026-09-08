import type { Server } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface RemoteServerOptions {
  /** Host to bind (default: '127.0.0.1'). */
  host?: string;
  /** Port to bind (default: 3000). */
  port?: number;
  /** Authorized tokens (string, comma list, or Map<token, label>). */
  authTokens?: string | string[] | Map<string, string>;
  /** Explicit flag to allow binding to public addresses without authentication. */
  insecureNoAuth?: boolean;
  /** When true, disables set/reset mutations in biomcp_configure (default: true). */
  readOnlyConfig?: boolean;
  /** Enables JSONL trace recording. */
  traceEnabled?: boolean;
  /** Path to write trace logs (default: ./biomcp-traces.jsonl). */
  traceFile?: string;
  /** Idle timeout in milliseconds for sessions (default: 30 minutes). */
  idleTimeoutMs?: number;
  /** Maximum number of concurrent sessions (default: 500). */
  maxSessions?: number;
  /**
   * JSON response mode for Streamable HTTP:
   * - 'auto': negotiates based on Accept header on initialize request (default)
   * - 'always': always returns application/json responses
   * - 'never': always uses SSE text/event-stream
   */
  enableJsonResponse?: 'auto' | 'always' | 'never';
}

export interface RemoteSession {
  sessionId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  clientLabel: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface RemoteServerInstance {
  server: Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

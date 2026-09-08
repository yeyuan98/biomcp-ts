import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { SessionManager } from './session.js';
import { Tracer } from './tracer.js';
import { handleCorsPreflight, parseAuthTokens, setCorsHeaders, verifyBearerToken } from './auth.js';
import { artifactCount, purgeArtifactsOlderThan } from '../biowasm/artifacts.js';
import { shutdownDbBackend } from '../server/tools/db.js';
import { shutdownREngine } from '../server/tools/ranalysis.js';
import { shutdownBiowasmEngine } from '../server/tools/biowasm.js';
import { VERSION } from '../version.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteServerInstance, RemoteServerOptions } from './types.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB payload ceiling

async function readJsonBody(req: IncomingMessage): Promise<{ raw: string; parsed?: unknown; payloadTooLarge?: boolean }> {
  let raw = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_BODY_BYTES) {
      return { raw: '', payloadTooLarge: true };
    }
    raw += chunk;
  }
  if (!raw.trim()) {
    return { raw };
  }
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    return { raw };
  }
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
  );
}

/**
 * Starts a self-hosted Streamable HTTP MCP server on Node.js.
 */
export async function startRemoteServer(options?: RemoteServerOptions): Promise<RemoteServerInstance> {
  const host = options?.host ?? process.env.BIOMCP_HOST ?? '127.0.0.1';
  const port = options?.port ?? (process.env.BIOMCP_PORT ? parseInt(process.env.BIOMCP_PORT, 10) : 3000);

  const rawTokens = options?.authTokens ?? process.env.BIOMCP_AUTH_TOKENS ?? process.env.BIOMCP_AUTH_TOKEN;
  const validTokens = parseAuthTokens(rawTokens);

  const isLocalHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLocalHost && validTokens.size === 0 && !options?.insecureNoAuth) {
    throw new Error(
      `Refusing to bind remote MCP server to non-localhost (${host}) without authentication. ` +
        'Set BIOMCP_AUTH_TOKEN or pass authTokens in options (or set --insecure-no-auth if intentionally public).',
    );
  }

  // If local without any configured tokens, generate an ephemeral token for safety
  if (isLocalHost && validTokens.size === 0 && !options?.insecureNoAuth) {
    const ephemeralToken = randomBytes(24).toString('hex');
    validTokens.set(ephemeralToken, 'localhost-ephemeral');
    console.error(`[biomcp] Localhost mode active. Generated ephemeral auth token: ${ephemeralToken}`);
    console.error(`[biomcp] Use header: Authorization: Bearer ${ephemeralToken}`);
  }

  const tracer = new Tracer({
    enabled: options?.traceEnabled ?? (process.env.BIOMCP_TRACE === 'true' || process.env.BIOMCP_TRACE === '1'),
    filePath: options?.traceFile ?? process.env.BIOMCP_TRACE_FILE,
  });

  const sessionManager = new SessionManager(options?.idleTimeoutMs, options?.maxSessions);
  sessionManager.startIdleSweeper();

  // Purge expired biowasm artifacts (>24 hours) on startup and hourly
  try {
    const initialPurge = purgeArtifactsOlderThan(24 * 60 * 60 * 1000);
    if (initialPurge.purgedCount > 0) {
      console.error(
        `[biomcp] Purged ${initialPurge.purgedCount} expired biowasm artifact(s) (${Math.round(initialPurge.reclaimedBytes / 1024)} KB reclaimed)`,
      );
    }
  } catch {
    // Ignore initial purge error
  }

  const purgeInterval = setInterval(() => {
    try {
      purgeArtifactsOlderThan(24 * 60 * 60 * 1000);
    } catch {
      // Ignore background purge error
    }
  }, 60 * 60 * 1000);
  purgeInterval.unref();

  const server = createServer(async (req, res) => {
    const startTime = performance.now();
    let clientLabel = 'anonymous';
    let sessionId: string | undefined;

    res.on('finish', () => {
      tracer.recordHttp(
        req.method ?? 'GET',
        req.url ?? '/',
        res.statusCode,
        performance.now() - startTime,
        clientLabel,
        req.socket.remoteAddress,
        sessionId,
      );
    });

    if (handleCorsPreflight(req, res)) {
      return;
    }

    setCorsHeaders(res);

    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Minimal unauthenticated health check for load balancers & Caddy
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Authenticated admin diagnostics status
    if (req.method === 'GET' && pathname === '/admin/status') {
      const auth = verifyBearerToken(req.headers.authorization, validTokens);
      if (!auth.authorized) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Bearer error="invalid_token"',
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            status: 'ok',
            version: VERSION,
            uptime: Math.round(process.uptime()),
            sessions: sessionManager.count,
            memory: process.memoryUsage(),
            biowasmArtifacts: artifactCount(),
          },
          null,
          2,
        ),
      );
      return;
    }

    // Modern Streamable HTTP Endpoint (/mcp)
    if (pathname === '/mcp') {
      // 1. Authenticate
      if (validTokens.size > 0) {
        const auth = verifyBearerToken(req.headers.authorization, validTokens);
        if (!auth.authorized) {
          res.writeHead(401, {
            'WWW-Authenticate': 'Bearer error="invalid_token"',
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }));
          return;
        }
        clientLabel = auth.clientLabel ?? 'default';
      }

      sessionId = req.headers['mcp-session-id'] as string | undefined;

      // 2. Handle POST
      if (req.method === 'POST') {
        const { parsed, payloadTooLarge } = await readJsonBody(req);
        if (payloadTooLarge) {
          sendJsonRpcError(res, 413, -32000, 'Payload Too Large: Request body exceeds 10 MB ceiling');
          return;
        }
        if (parsed === undefined) {
          sendJsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON');
          return;
        }

        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const isInit = messages.some((m) => m && typeof m === 'object' && m.method === 'initialize');

        if (isInit) {
          let enableJsonResponse = false;
          const configMode = options?.enableJsonResponse ?? 'auto';
          if (configMode === 'always') {
            enableJsonResponse = true;
          } else if (configMode === 'never') {
            enableJsonResponse = false;
          } else {
            const accept = req.headers.accept ?? '';
            enableJsonResponse = accept.includes('application/json') && !accept.includes('text/event-stream');
          }

          const session = await sessionManager.createSession({
            clientLabel,
            enableJsonResponse,
            readOnlyConfig: options?.readOnlyConfig ?? true,
          });

          sessionId = session.sessionId;
          await session.transport.handleRequest(req, res, parsed);
          return;
        }

        // Non-initialize request requires a valid session
        if (!sessionId) {
          sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
          return;
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          sendJsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }

        // Tool trace tap
        const toolMsg = messages.find((m) => m && typeof m === 'object' && m.method === 'tools/call');
        if (toolMsg) {
          const toolName = String(toolMsg.params?.name ?? 'unknown');
          const toolArgs = (toolMsg.params?.arguments ?? {}) as Record<string, unknown>;
          const toolStart = performance.now();

          // Intercept output chunks to record status
          const originalWrite = res.write.bind(res);
          const originalEnd = res.end.bind(res);
          let bodyAcc = '';

          res.write = (chunk: any, ...args: any[]): boolean => {
            if (chunk && typeof chunk !== 'function' && bodyAcc.length < 4096) {
              bodyAcc += chunk.toString();
            }
            return (originalWrite as any)(chunk, ...args);
          };

          res.end = (chunk: any, ...args: any[]): ServerResponse => {
            if (chunk && typeof chunk !== 'function' && bodyAcc.length < 4096) {
              bodyAcc += chunk.toString();
            }
            const isErr = bodyAcc.includes('"isError":true') || bodyAcc.includes('"error":{');
            tracer.recordTool(
              toolName,
              performance.now() - toolStart,
              isErr ? 'error' : 'success',
              clientLabel,
              sessionId,
              toolArgs,
              isErr ? 'Tool execution reported error' : undefined,
            );
            return (originalEnd as any)(chunk, ...args);
          };
        }

        await session.transport.handleRequest(req, res, parsed);
        return;
      }

      // 3. Handle GET (SSE stream for notifications)
      if (req.method === 'GET') {
        const accept = req.headers.accept ?? '';
        if (!accept.includes('text/event-stream')) {
          res.writeHead(406, { 'Content-Type': 'text/plain' });
          res.end('Not Acceptable: Client must accept text/event-stream');
          return;
        }

        if (!sessionId) {
          sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
          return;
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          sendJsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }

        await session.transport.handleRequest(req, res);
        return;
      }

      // 4. Handle DELETE (Session termination)
      if (req.method === 'DELETE') {
        if (!sessionId) {
          sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
          return;
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          sendJsonRpcError(res, 404, -32001, 'Session not found');
          return;
        }

        await session.transport.handleRequest(req, res);
        await sessionManager.closeSession(sessionId);
        return;
      }

      // Method not allowed on /mcp
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
      return;
    }

    // Any other pathname
    sendJsonRpcError(res, 404, -32000, 'Not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.once('error', reject);
  });

  return {
    server,
    host,
    port,
    close: async () => {
      clearInterval(purgeInterval);
      sessionManager.stopIdleSweeper();
      await sessionManager.closeAll();
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await shutdownDbBackend();
      await shutdownREngine();
      await shutdownBiowasmEngine();
    },
  };
}

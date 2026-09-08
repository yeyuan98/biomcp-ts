import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import { startRemoteServer } from '../../remote/server.js';
import type { RemoteServerInstance } from '../../remote/types.js';

describe('Streamable HTTP Remote Server', () => {
  let instance: RemoteServerInstance;
  let baseUrl: string;
  const token = 'test-secret-token-123';

  beforeAll(async () => {
    // Port 0 selects an available ephemeral port
    instance = await startRemoteServer({
      host: '127.0.0.1',
      port: 0,
      authTokens: `${token}:test-client`,
      traceEnabled: false,
    });
    const addr = instance.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : instance.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (instance) {
      await instance.close();
    }
  });

  it('serves unauthenticated /health probe', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('guards /admin/status with authentication', async () => {
    const unauth = await fetch(`${baseUrl}/admin/status`);
    expect(unauth.status).toBe(401);

    const auth = await fetch(`${baseUrl}/admin/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(auth.status).toBe(200);
    const body = (await auth.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.version).toBeDefined();
    expect(typeof body.uptime).toBe('number');
  });

  it('handles CORS OPTIONS preflight', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('Mcp-Session-Id');
  });

  it('rejects unauthenticated /mcp POST', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('handles full Streamable HTTP lifecycle (initialize -> tool call -> delete)', async () => {
    // 1. Initialize session
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-harness', version: '1.0' },
        },
      }),
    });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // 2. Call tools/list with session ID
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': sessionId!,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).toContain('gene_search');
    expect(listText).toContain('biomcp_configure');

    // 3. Verify remote read-only lockdown on biomcp_configure (action: "set")
    const setConfigRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': sessionId!,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'biomcp_configure',
          arguments: {
            action: 'set',
            values: { 'features.database.enabled': true },
          },
        },
      }),
    });

    expect(setConfigRes.status).toBe(200);
    const setConfigText = await setConfigRes.text();
    expect(setConfigText).toContain('Configuration mutation is disabled in remote self-hosted mode');

    // 4. Terminate session via DELETE
    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': sessionId!,
      },
    });
    expect([200, 204]).toContain(delRes.status);

    // 5. Subsequent request with deleted session ID returns 404 Not Found
    const expiredRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Mcp-Session-Id': sessionId!,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(expiredRes.status).toBe(404);
    const expiredJson = (await expiredRes.json()) as any;
    expect(expiredJson.error.code).toBe(-32001);
    expect(expiredJson.error.message).toBe('Session not found');
  });

  it('returns 406 when GET /mcp is called without text/event-stream accept header', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/html',
      },
    });
    expect(res.status).toBe(406);
  });
});

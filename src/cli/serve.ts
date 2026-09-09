import { startRemoteServer } from '../remote/server.js';
import type { RemoteServerOptions } from '../remote/types.js';

export async function runServe(options?: RemoteServerOptions): Promise<void> {
  const instance = await startRemoteServer(options);

  console.log(`[biomcp] Streamable HTTP server listening on http://${instance.host}:${instance.port}/mcp`);
  console.log(`[biomcp] Health endpoint: http://${instance.host}:${instance.port}/health`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[biomcp] Shutting down remote server...');
    try {
      await instance.close();
      console.log('[biomcp] Server closed successfully.');
      process.exit(0);
    } catch (err) {
      console.error('[biomcp] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

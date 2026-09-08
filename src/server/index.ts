#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBioMcpServer } from './factory.js';
import { shutdownDbBackend } from './tools/db.js';
import { shutdownREngine } from './tools/ranalysis.js';
import { shutdownBiowasmEngine } from './tools/biowasm.js';

const server = createBioMcpServer();

async function main() {
  // Attach BEFORE connect(): if the client dies while the handshake is still
  // resolving, 'end'/'close' may already have fired and a later listener
  // would miss the only notification — the exact orphan this guard prevents.
  installStdinCloseExitGuard();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on('exit', () => {
    void shutdownDbBackend();
    void shutdownREngine();
    void shutdownBiowasmEngine();
  });
}

/**
 * The SDK's stdio transport never exits the process: it listens for
 * `data`/`error` only, and `close()` merely pauses stdin. If the parent
 * (MCP client / npm exec) dies, the webR worker and other handles keep the
 * event loop alive — an orphaned ~1 GB server. When the client goes away the
 * write end of our stdin closes; exit then, so nothing lingers.
 */
function installStdinCloseExitGuard(): void {
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    // Unref'd grace period lets in-flight responses flush and the 'exit'
    // shutdown hooks run; if the loop is otherwise empty it ends sooner.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.stdin.on('end', exit);
  process.stdin.on('close', exit);
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});

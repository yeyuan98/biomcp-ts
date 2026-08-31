#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGeneTools } from './tools/gene.js';
import { registerVariantTools } from './tools/variant.js';
import { registerDrugTools } from './tools/drug.js';
import { registerDiseaseTools } from './tools/disease.js';
import { registerArticleTools } from './tools/article.js';
import { registerTrialTools } from './tools/trial.js';
import { registerUtilityTools } from './tools/utility.js';
import { registerPdbTools } from './tools/pdb.js';
import { registerPatentTools } from './tools/patent.js';
import { registerGeoTools } from './tools/geo.js';
import { registerSraTools } from './tools/sra.js';
import { registerGenbankTools } from './tools/genbank.js';
import { registerGtexTools } from './tools/gtex.js';
import { registerEnsemblTools } from './tools/ensembl.js';
import { registerDbToolsIfConfigured, shutdownDbBackend } from './tools/db.js';
import { registerAnalysisRToolsIfConfigured, shutdownREngine } from './tools/ranalysis.js';
import { registerBiowasmToolsIfConfigured, shutdownBiowasmEngine } from './tools/biowasm.js';
import { registerConfigureTool } from './tools/configure.js';
import { loadAndApplyToEnv } from '../config/handler.js';
import { VERSION } from '../version.js';

const server = new McpServer({
  name: 'biomcp',
  version: VERSION,
});

// Project config (.biomcp.json in the server cwd) fills unset env vars before
// any registration: env vars always take precedence. Synchronous by design —
// registration happens at module top level.
loadAndApplyToEnv();

registerGeneTools(server);
registerVariantTools(server);
registerDrugTools(server);
registerDiseaseTools(server);
registerArticleTools(server);
registerTrialTools(server);
registerUtilityTools(server);
registerPdbTools(server);
registerPatentTools(server);
registerGeoTools(server);
registerSraTools(server);
registerGenbankTools(server);
registerGtexTools(server);
registerEnsemblTools(server);
registerConfigureTool(server);
const dbEnabled = registerDbToolsIfConfigured(server);
if (dbEnabled) {
  console.error(`[biomcp] database tools enabled via DB_TYPE=${process.env.DB_TYPE}`);
}
const analysisREnabled = registerAnalysisRToolsIfConfigured(server);
if (analysisREnabled) {
  console.error('[biomcp] R analysis tools enabled via ANALYSIS_R');
}
const biowasmEnabled = registerBiowasmToolsIfConfigured(server);
if (biowasmEnabled) {
  console.error('[biomcp] Biowasm analysis tools enabled via ANALYSIS_BIOWASM');
}

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

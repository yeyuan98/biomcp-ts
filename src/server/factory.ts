import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
import { registerDbToolsIfConfigured } from './tools/db.js';
import { registerAnalysisRToolsIfConfigured } from './tools/ranalysis.js';
import { registerBiowasmToolsIfConfigured } from './tools/biowasm.js';
import { registerConfigureTool } from './tools/configure.js';
import { loadAndApplyToEnv } from '../config/handler.js';
import { VERSION } from '../version.js';

let initialLogged = false;

export interface CreateBioMcpServerOptions {
  /**
   * When true, disables set/reset mutations in `biomcp_configure`,
   * preventing remote callers from modifying local project configuration.
   */
  readOnlyConfig?: boolean;
}

/**
 * Creates and registers tools on a new McpServer instance.
 * Completely transport-agnostic and free of any HTTP/stdio transport binding.
 */
export function createBioMcpServer(options?: CreateBioMcpServerOptions): McpServer {
  const server = new McpServer({
    name: 'biomcp',
    version: VERSION,
  });

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
  registerConfigureTool(server, { readOnlyConfig: options?.readOnlyConfig });

  const dbEnabled = registerDbToolsIfConfigured(server);
  if (dbEnabled && !initialLogged) {
    console.error(`[biomcp] database tools enabled via DB_TYPE=${process.env.DB_TYPE}`);
  }
  const analysisREnabled = registerAnalysisRToolsIfConfigured(server);
  if (analysisREnabled && !initialLogged) {
    console.error('[biomcp] R analysis tools enabled via ANALYSIS_R');
  }
  const biowasmEnabled = registerBiowasmToolsIfConfigured(server);
  if (biowasmEnabled && !initialLogged) {
    console.error('[biomcp] Biowasm analysis tools enabled via ANALYSIS_BIOWASM');
  }
  initialLogged = true;

  return server;
}

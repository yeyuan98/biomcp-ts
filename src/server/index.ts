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

const server = new McpServer({
  name: 'biomcp',
  version: '1.0.0',
});

registerGeneTools(server);
registerVariantTools(server);
registerDrugTools(server);
registerDiseaseTools(server);
registerArticleTools(server);
registerTrialTools(server);
registerUtilityTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerGeneTools } from '../../server/tools/gene.js';
import { registerVariantTools } from '../../server/tools/variant.js';
import { registerDrugTools } from '../../server/tools/drug.js';
import { registerDiseaseTools } from '../../server/tools/disease.js';
import { registerArticleTools } from '../../server/tools/article.js';
import { registerTrialTools } from '../../server/tools/trial.js';
import { registerUtilityTools } from '../../server/tools/utility.js';
import { connectionManager } from '../../connections/manager.js';

export type McpTestHarness = {
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  listTools: () => Promise<unknown>;
  close: () => Promise<void>;
};

export async function createMcpTestHarness(): Promise<McpTestHarness> {
  const server = new McpServer({ name: 'test-biomcp', version: '1.0.0' });

  registerGeneTools(server);
  registerVariantTools(server);
  registerDrugTools(server);
  registerDiseaseTools(server);
  registerArticleTools(server);
  registerTrialTools(server);
  registerUtilityTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) {
        const text = (result.content[0] as { text: string }).text;
        throw new Error(`Tool '${name}' returned error: ${text}`);
      }
      return JSON.parse((result.content[0] as { text: string }).text);
    },
    listTools: () => client.listTools(),
    close: async () => {
      await client.close();
      connectionManager.closeAll();
    },
  };
}

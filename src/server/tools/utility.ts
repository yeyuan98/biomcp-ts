import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discover, batchGet } from '../../entities/cross-entity.js';

export function registerUtilityTools(server: McpServer): void {
  server.registerTool(
    'discover',
    {
      description: 'Free-text concept resolution - find entities matching a free-text query',
      inputSchema: {
        query: z.string().describe('Free-text query (e.g., "BRAF V600E", "lung cancer", "imatinib")'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query }) => {
      try {
        const results = await discover(query);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'batch_get',
    {
      description: 'Get multiple entities in parallel',
      inputSchema: {
        inputs: z.array(z.object({
          entity: z.enum(['gene', 'variant', 'drug', 'disease', 'trial', 'article']),
          id: z.string(),
          sections: z.array(z.string()).optional(),
        })).describe('List of entity requests'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ inputs }) => {
      try {
        const results = await batchGet(inputs);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}

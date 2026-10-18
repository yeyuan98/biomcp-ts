import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discover, batchGet } from '../../entities/cross-entity.js';
import { requiredString } from './utils.js';

export function registerUtilityTools(server: McpServer): void {
  server.registerTool(
    'discover',
    {
      description: 'Free-text concept resolution - find entities matching a free-text query. Prefers a candidate whose name/symbol exactly matches the query (case-insensitive) over the backend\'s first hit; each result\'s matched_on field reports why it was picked ("exact" or "first")',
      inputSchema: {
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Free-text query (e.g., "BRAF V600E", "lung cancer", "imatinib")'),
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
      description: 'Get multiple entities in parallel. Article items return metadata (with inline abstract) by default; for full text pass sections:["fulltext"] on the item — PMC articles then return a small file handle (file_path + outline, never body text inline) while non-PMC articles return an explicit unavailable + reason. Nonexistent PMIDs yield a per-item error and the batch continues. For inline text use article_get with fulltext_output="inline"',
      inputSchema: {
        inputs: z.array(z.object({
          entity: z.enum(['gene', 'variant', 'drug', 'disease', 'trial', 'article', 'patent']),
          id: requiredString('Entity ID'),
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

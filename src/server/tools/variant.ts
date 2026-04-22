import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { variantSearch, variantGet } from '../../entities/variant.js';

export function registerVariantTools(server: McpServer): void {
  server.registerTool(
    'variant_search',
    {
      description: 'Search for variants by gene, rsid, or HGVS notation',
      inputSchema: {
        query: z.string().describe('Variant query (gene, rsid, or HGVS notation)'),
        gene: z.string().optional().describe('Filter by gene'),
        significance: z.enum(['benign', 'likely_benign', 'pathogenic', 'likely_pathogenic', 'uncertain']).optional(),
        max_frequency: z.number().optional().describe('Maximum allele frequency (0-1)'),
        limit: z.number().int().min(1).max(50).default(10),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, gene, significance, max_frequency, limit, offset }) => {
      try {
        const results = await variantSearch({ query, gene, significance, max_frequency, limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'variant_get',
    {
      description: 'Get detailed variant information',
      inputSchema: {
        id: z.string().describe('Variant ID (rsid, HGVS, or ClinVar ID)'),
        sections: z.array(z.enum(['core', 'frequency', 'predictions', 'clinical'])).optional().describe('Sections to include'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, sections }) => {
      try {
        const result = await variantGet(id, sections);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
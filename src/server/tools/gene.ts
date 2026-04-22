import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { geneSearch, geneGet } from '../../entities/gene.js';

const GENE_SECTIONS = [
  'pathways', 'ontology', 'diseases', 'diagnostics', 'protein',
  'go', 'interactions', 'civic', 'expression', 'hpa', 'druggability',
  'clingen', 'constraint', 'disgenet', 'funding', 'all'
] as const;

export function registerGeneTools(server: McpServer): void {
  server.registerTool(
    'gene_search',
    {
      description: 'Search for genes by symbol, name, or keyword',
      inputSchema: {
        query: z.string().describe('Gene symbol, name, or keyword to search for'),
        gene_type: z.enum(['protein-coding', 'ncRNA', 'pseudo']).optional().describe('Filter by gene type'),
        chromosome: z.string().optional().describe('Filter by chromosome (e.g., "7", "X")'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, gene_type, chromosome, limit, offset }) => {
      try {
        const results = await geneSearch(query, { gene_type, chromosome, limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { 
          content: [{ type: 'text', text: String(error) }],
          isError: true 
        };
      }
    }
  );

  server.registerTool(
    'gene_get',
    {
      description: 'Get detailed gene information by symbol',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol (e.g., "BRAF", "TP53")'),
        sections: z.array(z.enum(GENE_SECTIONS)).optional().describe('Sections to include'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, sections }) => {
      try {
        const result = await geneGet(symbol, sections);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { 
          content: [{ type: 'text', text: String(error) }],
          isError: true 
        };
      }
    }
  );

  server.registerTool(
    'gene_pathways',
    {
      description: 'Get pathways containing a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, limit }) => {
      try {
        const result = await geneGet(symbol, ['pathways']);
        const pathways = (result as { pathways?: Array<{ id: string; name: string }> }).pathways?.slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(pathways) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_diseases',
    {
      description: 'Get diseases associated with a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, limit }) => {
      try {
        const result = await geneGet(symbol, ['disgenet']);
        const diseases = (result as { disgenet?: { associations: Array<{ disease_name: string }> } }).disgenet?.associations?.slice(0, limit).map(d => d.disease_name) || [];
        return { content: [{ type: 'text', text: JSON.stringify(diseases) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
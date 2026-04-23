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

  server.registerTool(
    'gene_go_enrichment',
    {
      description: 'Get GO term enrichment for a gene via QuickGO',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol }) => {
      try {
        const result = await geneGet(symbol, ['ontology']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.ontology) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_interactions',
    {
      description: 'Get protein interactions for a gene via STRING',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, limit }) => {
      try {
        const result = await geneGet(symbol, ['interactions']);
        const interactions = (result as { interactions?: Array<{ symbol: string; score: number }> }).interactions?.slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(interactions) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_expression',
    {
      description: 'Get GTEx tissue expression for a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, limit }) => {
      try {
        const result = await geneGet(symbol, ['expression']);
        const tissues = (result as { expression?: { tissues?: Array<{ tissue: string; tpm: number }> } }).expression?.tissues?.slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(tissues) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_constraint',
    {
      description: 'Get gnomAD constraint metrics for a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol }) => {
      try {
        const result = await geneGet(symbol, ['constraint']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.constraint) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_druggability',
    {
      description: 'Get druggability data for a gene via DGIdb and OpenTargets',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol }) => {
      try {
        const result = await geneGet(symbol, ['druggability']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.druggability) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_clingen',
    {
      description: 'Get ClinGen dosage sensitivity for a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol }) => {
      try {
        const result = await geneGet(symbol, ['clingen']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.clingen) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
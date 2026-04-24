import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { geneSearch, geneGet } from '../../entities/gene.js';
import { sectionResult, getSectionError } from '../errors.js';

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
        const data = sectionResult<any[]>(result, 'pathways');
        if (data && typeof data === 'object' && '_error' in data) {
          return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
        }
        const pathways = (Array.isArray(data) ? data : []).slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(pathways) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_diseases',
    {
      description: 'Get diseases associated with a gene. Requires DISGENET_API_KEY environment variable for DisGeNET data; falls back to OpenTargets gene-disease associations when unavailable.',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, limit }) => {
      try {
        const result = await geneGet(symbol, ['disgenet', 'diseases']);
        const disgenetData = sectionResult<{ associations?: Array<{ disease_name: string; score: number; source: string }> }>(result, 'disgenet');
        if (disgenetData && typeof disgenetData === 'object' && '_error' in disgenetData) {
          const diseaseData = sectionResult<{ diseases?: Array<{ name: string; source: string }> }>(result, 'diseases');
          if (diseaseData && typeof diseaseData === 'object' && !('_error' in diseaseData) && Array.isArray((diseaseData as any).diseases)) {
            return { content: [{ type: 'text', text: JSON.stringify((diseaseData as any).diseases.slice(0, limit)) }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify(disgenetData) }], isError: true };
        }
        const associations = (disgenetData as any)?.associations;
        const diseases = (Array.isArray(associations) ? associations : []).slice(0, limit).map((d: any) => d.disease_name) || [];
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
        const data = sectionResult(result, 'ontology');
        if (data && typeof data === 'object' && '_error' in data) {
          return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
        }
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
        const data = sectionResult<any[]>(result, 'interactions');
        if (data && typeof data === 'object' && '_error' in data) {
          return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
        }
        const interactions = (Array.isArray(data) ? data : []).slice(0, limit) || [];
        return { content: [{ type: 'text', text: JSON.stringify(interactions) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gene_expression',
    {
      description: 'Get GTEx tissue expression for a gene. Note: GTEx v8 covers ~54 tissues; some genes may not have expression data if they are not expressed in GTEx tissue samples.',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, limit }) => {
      try {
        const result = await geneGet(symbol, ['expression']);
        const data = sectionResult<{ tissues?: Array<{ tissue: string; tpm: number }> }>(result, 'expression');
        if (data && typeof data === 'object' && '_error' in data) {
          return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
        }
        const tissues = (data as any)?.tissues?.slice(0, limit) || [];
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
        const data = sectionResult(result, 'constraint');
        if (data && typeof data === 'object' && '_error' in data) {
          return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: true };
        }
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
      description: 'Get ClinGen dosage sensitivity for a gene. Note: ClinGen does not provide a public API; data is not available programmatically.',
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

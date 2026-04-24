import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  geneToDrugs,
  geneToTrials,
  geneToArticles,
  variantToTrials,
  drugToGenes,
  drugToTrials,
  geneEnrichment,
  discover,
  searchAll,
  batchGet,
} from '../../entities/cross-entity.js';

export function registerPivotTools(server: McpServer): void {
  server.registerTool(
    'gene_drugs',
    {
      description: 'Find drugs targeting a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol (e.g., "BRAF", "TP53")'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ symbol }) => {
      const results = await geneToDrugs(symbol);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'gene_trials',
    {
      description: 'Find clinical trials for a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ symbol }) => {
      const results = await geneToTrials(symbol);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'gene_articles',
    {
      description: 'Find articles about a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ symbol }) => {
      const results = await geneToArticles(symbol);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'variant_trials',
    {
      description: 'Find clinical trials for a variant',
      inputSchema: {
        variant: z.string().describe('Variant ID (rsID, HGVS, or variant ID)'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ variant }) => {
      const results = await variantToTrials(variant);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'drug_genes',
    {
      description: 'Find genes targeted by a drug',
      inputSchema: {
        drug: z.string().describe('Drug name'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ drug }) => {
      const results = await drugToGenes(drug);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'drug_trials',
    {
      description: 'Find clinical trials for a drug',
      inputSchema: {
        drug: z.string().describe('Drug name'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ drug }) => {
      const results = await drugToTrials(drug);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'gene_enrich',
    {
      description: 'Perform pathway enrichment analysis for a gene list',
      inputSchema: {
        genes: z.array(z.string()).describe('List of HGNC gene symbols'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ genes }) => {
      const results = await geneEnrichment(genes);
      if (results.length === 1 && results[0] && '_error' in results[0]) {
        return { content: [{ type: 'text', text: JSON.stringify(results[0]) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

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
      const results = await discover(query);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );

  server.registerTool(
    'search_all',
    {
      description: 'Federated search across all entity types',
      inputSchema: {
        query: z.string().describe('Query term'),
        limit: z.number().int().min(1).max(20).default(5).describe('Results per entity'),
        entities: z.array(z.enum(['gene', 'variant', 'drug', 'disease', 'article', 'trial'])).optional()
          .describe('Entities to search (default: all)'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, limit, entities }) => {
      const results = await searchAll(query, { limit, entities });
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
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
      const results = await batchGet(inputs);
      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    }
  );
}
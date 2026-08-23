import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { geneSearch, geneGet } from '../../entities/gene.js';
import { geneToDrugs, geneToTrials, geneToArticles, geneEnrichment } from '../../entities/cross-entity.js';
import { applyLimit, sliceArraysRecursive } from './utils.js';

const GENE_SECTIONS = [
  'core', 'pathways', 'ontology', 'diseases', 'protein',
  'go', 'interactions', 'clinical_evidence', 'expression', 'protein_atlas', 'druggability',
  'dosage_sensitivity', 'constraint', 'disease_associations', 'funding', 'all'
] as const;

const GENE_ALL_SECTIONS = [
  'pathways', 'protein', 'ontology', 'go', 'interactions',
  'clinical_evidence', 'expression', 'protein_atlas',
  'druggability', 'dosage_sensitivity', 'constraint',
  'disease_associations', 'diseases', 'funding',
];
const GENE_STORAGE_KEYS: Record<string, string> = {
  clinical_evidence: 'civic',
  protein_atlas: 'hpa',
  disease_associations: 'disgenet',
  dosage_sensitivity: 'clingen',
};
const GENE_ARRAY_KEYS: Record<string, string[]> = {
  pathways: [],
  go: [],
  ontology: ['go_enrichment'],
  interactions: [],
  expression: ['tissues'],
  clinical_evidence: ['variants'],
  protein_atlas: ['subcellular'],
  disease_associations: ['associations'],
  diseases: ['diseases'],
  funding: ['grants'],
  druggability: ['dgidb'],
};

export function registerGeneTools(server: McpServer): void {
  server.registerTool(
    'gene_search',
    {
      description: 'Search for genes by symbol, name, or keyword',
      inputSchema: {
        query: z.string().describe('Gene symbol, name, or keyword to search for'),
        chromosome: z.string().optional().describe('Filter by chromosome (e.g., "7", "X")'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, chromosome, limit, offset }) => {
      try {
        const results = await geneSearch(query, { chromosome, limit, offset });
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
        symbol: z.string().describe('Official HGNC gene symbol (e.g., "BRAF", "TP53", "ERBB2"). Common aliases like "HER2" or "NEU" are NOT accepted unless smart=true is enabled.'),
        sections: z.array(z.enum(GENE_SECTIONS)).optional().describe('Sections to include'),
        limit: z.number().int().min(1).max(100).default(20),
        smart: z.boolean().default(false).describe('When true, automatically resolves gene aliases and common names to the official HGNC symbol before lookup (e.g., "HER2" → "ERBB2"). Zero overhead when input is already a valid HGNC symbol.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, sections, limit, smart }) => {
      try {
        const result = await geneGet(symbol, sections, smart);
        const requestedSections = (sections ?? []).includes('all')
          ? GENE_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          applyLimit(result.sections, requestedSections, GENE_STORAGE_KEYS, GENE_ARRAY_KEYS, limit);
        }
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
        const disgenetData = result.sections?.disgenet;
        if (disgenetData && typeof disgenetData === 'object' && '_error' in disgenetData) {
          const diseaseData = result.sections?.diseases;
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
    'gene_drugs',
    {
      description: 'Find drugs targeting a gene',
      inputSchema: {
        symbol: z.string().describe('HGNC gene symbol (e.g., "BRAF", "TP53")'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ symbol }) => {
      try {
        const results = await geneToDrugs(symbol);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
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
      try {
        const results = await geneToTrials(symbol);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
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
      try {
        const results = await geneToArticles(symbol);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
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
      try {
        const results = await geneEnrichment(genes);
        if (results.length === 1 && results[0] && '_error' in results[0]) {
          return { content: [{ type: 'text', text: JSON.stringify(results[0]) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}

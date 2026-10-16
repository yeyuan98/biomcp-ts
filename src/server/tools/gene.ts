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
        query: z.string().trim().min(1, 'Query must be a non-empty string after trimming').describe('Gene symbol, name, or keyword to search for'),
        chromosome: z.string().optional().describe('Filter by chromosome: 1-22, X, Y, or M/MT (mitochondrial), with an optional "chr" prefix (e.g., "7", "chrX")'),
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
          result.sections = applyLimit(result.sections, requestedSections, GENE_STORAGE_KEYS, GENE_ARRAY_KEYS, limit);
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
          const disgenetReason = (disgenetData as { _error: string })._error;
          const diseaseData = result.sections?.diseases;
          if (diseaseData && typeof diseaseData === 'object' && !('_error' in diseaseData) && Array.isArray((diseaseData as any).diseases)) {
            return { content: [{ type: 'text', text: JSON.stringify((diseaseData as any).diseases.slice(0, limit)) }] };
          }
          // Both legs failed (or the fallback produced no usable data):
          // name BOTH reasons — never silently drop the OpenTargets failure.
          const otReason = diseaseData && typeof diseaseData === 'object' && '_error' in diseaseData
            ? (diseaseData as { _error: string })._error
            : 'no disease data returned';
          return {
            content: [{ type: 'text', text: JSON.stringify({ _error: `DisGeNET unavailable (${disgenetReason}); OpenTargets fallback also failed (${otReason})` }) }],
            isError: true,
          };
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
      description: 'Find drugs targeting a gene. Results are ranked by max clinical phase, then trial-report count, with salt forms collapsed',
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
      description: 'Perform pathway enrichment analysis for a gene list (Reactome over-representation). Requires at least 3 genes; the list is deduplicated (case-insensitive) before submission. Each pathway reports genes_overlap — the count of unique SUBMITTED genes Reactome matched there, resolved with one follow-up token lookup (Reactome\'s entity-level match count can exceed the gene count when one gene maps to multiple entities, e.g. a UniProt entry plus Ensembl gene/transcript). The reply also reports how many pathways Reactome found in total alongside the returned page.',
      inputSchema: {
        genes: z.array(z.string()).min(3, 'Gene enrichment requires at least 3 genes').describe('List of HGNC gene symbols (minimum 3; duplicates and case variants are collapsed before submission)'),
        limit: z.number().int().min(1).max(100).default(30).describe('Maximum pathways to return (1-100; Reactome reports up to ~100)'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ genes, limit }) => {
      try {
        const results = await geneEnrichment(genes, limit);
        if (Array.isArray(results) && results.length === 1 && '_error' in results[0]) {
          return { content: [{ type: 'text', text: JSON.stringify(results[0]) }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { geneSearch, geneGet } from '../../entities/gene.js';
import { geneToDrugs, geneToTrials, geneToArticles, geneEnrichment } from '../../entities/cross-entity.js';

const GENE_SECTIONS = [
  'pathways', 'ontology', 'diseases', 'protein',
  'go', 'interactions', 'clinical_evidence', 'expression', 'protein_atlas', 'druggability',
  'dosage_sensitivity', 'constraint', 'disease_associations', 'funding', 'all'
] as const;

function sliceArraysRecursive(obj: unknown, limit: number): unknown {
  if (Array.isArray(obj)) return obj.slice(0, limit);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = sliceArraysRecursive(v, limit);
    }
    return result;
  }
  return obj;
}

function applyLimit(
  sections: Record<string, unknown>,
  requestedNames: string[],
  storageKeyMap: Record<string, string>,
  arrayKeyMap: Record<string, string[]>,
  limit: number,
): void {
  for (const name of requestedNames) {
    const storedKey = storageKeyMap[name] ?? name;
    const data = sections[storedKey];
    if (!data || typeof data !== 'object') continue;

    const keys = arrayKeyMap[name];
    if (Array.isArray(data)) {
      sections[storedKey] = data.slice(0, limit);
    } else if (keys) {
      const obj = data as Record<string, unknown>;
      for (const k of keys) {
        if (Array.isArray(obj[k])) obj[k] = obj[k].slice(0, limit);
      }
    }
  }
}

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
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ symbol, sections, limit }) => {
      try {
        const result = await geneGet(symbol, sections);
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { variantSearch, variantGet, fetchOncoKbAnnotation, getVariantSearchFilters, getVariantGetSections } from '../../entities/variant.js';

const VARIANT_GET_SECTIONS = getVariantGetSections();
const VARIANT_SEARCH_FILTERS = getVariantSearchFilters();

export function registerVariantTools(server: McpServer): void {
  server.registerTool(
    'variant_search',
    {
      description: 'Search for variants by gene, rsid, or HGVS notation',
      inputSchema: {
        query: z.string().optional().describe('Variant query (gene, rsid, or HGVS notation)'),
        gene: z.string().optional().describe('Filter by gene symbol'),
        significance: z.enum(['benign', 'likely_benign', 'pathogenic', 'likely_pathogenic', 'uncertain']).optional(),
        max_frequency: z.number().optional().describe('Maximum allele frequency (0-1)'),
        min_cadd: z.number().optional().describe('Minimum CADD score'),
        consequence: z.string().optional().describe('Variant consequence (e.g., missense, synonymous)'),
        rsid: z.string().optional().describe('dbSNP rsID'),
        hgvsp: z.string().optional().describe('Protein change (e.g., V600E)'),
        hgvsc: z.string().optional().describe('cDNA change'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, gene, significance, max_frequency, min_cadd, consequence, rsid, hgvsp, hgvsc, limit, offset }) => {
      try {
        let searchQuery = query;
        if (!searchQuery && (rsid || hgvsp || hgvsc)) {
          const parts: string[] = [];
          if (rsid) parts.push(`rsid:${rsid}`);
          if (hgvsp) parts.push(`hgvsp:${hgvsp}`);
          if (hgvsc) parts.push(`hgvsc:${hgvsc}`);
          searchQuery = parts.join(' ');
        }
        const results = await variantSearch({ query: searchQuery, gene, significance, max_frequency, limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'variant_get',
    {
      description: 'Get detailed variant information with optional sections',
      inputSchema: {
        id: z.string().describe('Variant ID (rsid, HGVS, or ClinVar ID)'),
        sections: z.array(z.enum(['core', 'frequency', 'predictions', 'clinical', 'alphagenome', 'all'])).optional().describe('Sections to include: core, frequency, predictions, clinical, alphagenome'),
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

  server.registerTool(
    'variant_frequency',
    {
      description: 'Get population frequency data for a variant from gnomAD',
      inputSchema: {
        id: z.string().describe('Variant ID (rsid or HGVS)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id }) => {
      try {
        const result = await variantGet(id, ['frequency']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.frequency) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'variant_predictions',
    {
      description: 'Get pathogenicity predictions (CADD, SIFT, PolyPhen, conservation)',
      inputSchema: {
        id: z.string().describe('Variant ID (rsid or HGVS)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id }) => {
      try {
        const result = await variantGet(id, ['predictions']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.predictions) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'variant_oncokb',
    {
      description: 'Get OncoKB annotations for a variant in a cancer gene',
      inputSchema: {
        gene: z.string().describe('Gene symbol (e.g., BRAF, EGFR)'),
        protein_change: z.string().describe('Protein change (e.g., V600E, L858R)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ gene, protein_change }) => {
      try {
        const annotation = await fetchOncoKbAnnotation(gene, protein_change);
        if (!annotation) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'OncoKB annotation not found' }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(annotation) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'variant_alphagenome',
    {
      description: 'Get AlphaGenome variant scores via gRPC',
      inputSchema: {
        id: z.string().describe('Variant ID (rsid or HGVS)'),
        gene: z.string().optional().describe('Gene symbol to focus scoring'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, gene }) => {
      try {
        const result = await variantGet(id, ['alphagenome']);
        return { content: [{ type: 'text', text: JSON.stringify(result.sections?.alphagenome) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}
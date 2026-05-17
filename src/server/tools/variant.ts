import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { variantSearch, variantGet, fetchOncoKbAnnotation, getVariantSearchFilters } from '../../entities/variant.js';
import { variantToTrials } from '../../entities/cross-entity.js';

const VARIANT_GET_SECTIONS = ['core', 'frequency', 'predictions', 'clinical', 'alphagenome_scores', 'all'] as const;
const VARIANT_SEARCH_FILTERS = getVariantSearchFilters();

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

const VARIANT_ALL_SECTIONS = ['frequency', 'predictions', 'clinical', 'alphagenome_scores'];
const VARIANT_STORAGE_KEYS: Record<string, string> = {
  alphagenome_scores: 'alphagenome',
};

export function registerVariantTools(server: McpServer): void {
  server.registerTool(
    'variant_search',
    {
      description: `Search for variants. Use structured parameters for best results:
- rsid: e.g. query="rs113488022"
- HGVS: e.g. query="NM_004333.4:c.1799T>A"
- Gene filter: e.g. gene="BRAF" with hgvsp="V600E" or consequence="missense"
- ClinVar significance: e.g. significance="pathogenic"
Do NOT use compound free-text like "BRAF V600E" — use separate gene and hgvsp parameters instead.`,
      inputSchema: {
        query: z.string().optional().describe('Variant query (rsid or HGVS notation). Avoid compound queries like "BRAF V600E" — use gene + hgvsp parameters instead.'),
        gene: z.string().optional().describe('Filter by gene symbol (e.g., "BRAF"). Use together with hgvsp for protein change queries.'),
        significance: z.enum(['benign', 'likely_benign', 'pathogenic', 'likely_pathogenic', 'uncertain']).optional(),
        max_frequency: z.number().optional().describe('Maximum allele frequency (0-1)'),
        min_cadd: z.number().optional().describe('Minimum CADD score'),
        consequence: z.string().optional().describe('Variant consequence (e.g., missense, synonymous)'),
        rsid: z.string().optional().describe('dbSNP rsID'),
        hgvsp: z.string().optional().describe('Protein change (e.g., V600E). Use with gene parameter for compound queries.'),
        hgvsc: z.string().optional().describe('cDNA change'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
        offset: z.number().int().min(0).default(0).describe('Result offset'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ query, gene, significance, max_frequency, min_cadd, consequence, rsid, hgvsp, hgvsc, limit, offset }) => {
      try {
        let searchQuery = query;
        let searchGene = gene;
        let searchHgvsp = hgvsp;
        let searchHgvsc = hgvsc;

        if (!searchQuery && !searchGene && (rsid || hgvsp || hgvsc)) {
          const parts: string[] = [];
          if (rsid) parts.push(`dbsnp.rsid:${rsid}`);
          if (hgvsp) parts.push(`dbnsfp.hgvsp:*${hgvsp}*`);
          if (hgvsc) parts.push(`snpeff.ann.hgvs_c:"${hgvsc}"`);
          searchQuery = parts.join(' AND ');
        }

        if (!searchQuery && !rsid && !hgvsc && searchGene && searchHgvsp) {
          searchQuery = `cadd.gene.genename:${searchGene} AND dbnsfp.hgvsp:*${searchHgvsp}*`;
          searchGene = undefined;
          searchHgvsp = undefined;
        }

        if (searchQuery && !searchGene && !searchHgvsp) {
          const compoundMatch = searchQuery.match(/^([A-Za-z0-9_]+)\s+(V\d+[A-Z*])$/i);
          if (compoundMatch) {
            searchQuery = `cadd.gene.genename:${compoundMatch[1].toUpperCase()} AND dbnsfp.hgvsp:*${compoundMatch[2]}*`;
          }
        }

        const results = await variantSearch({
          query: searchQuery,
          gene: searchGene,
          hgvsp: searchHgvsp,
          hgvsc: searchHgvsc,
          significance,
          max_frequency,
          consequence,
          min_cadd,
          limit,
          offset
        });
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'variant_get',
    {
      description: 'Get detailed variant information with optional sections. Core data (id, gene, rsid, significance) is always returned at the top level. Use sections to request additional data.',
      inputSchema: {
        id: z.string().describe('Variant ID (rsid, HGVS, or ClinVar ID)'),
        sections: z.array(z.enum(VARIANT_GET_SECTIONS)).optional().describe('Sections to include: core, frequency, predictions, clinical, alphagenome_scores'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, sections, limit }) => {
      try {
        const result = await variantGet(id, sections);
        const requestedSections = (sections ?? []).includes('all')
          ? VARIANT_ALL_SECTIONS
          : (sections ?? []);
        if (result.sections) {
          for (const name of requestedSections) {
            const storedKey = VARIANT_STORAGE_KEYS[name] ?? name;
            const data = result.sections[storedKey];
            if (data && typeof data === 'object') {
              result.sections[storedKey] = sliceArraysRecursive(data, limit);
            }
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'variant_oncokb',
    {
      description: 'Get OncoKB annotations for a variant in a cancer gene. Requires ONCOKB_TOKEN environment variable.',
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
    'variant_trials',
    {
      description: 'Find clinical trials for a variant',
      inputSchema: {
        variant: z.string().describe('Variant ID (rsID, HGVS, or variant ID)'),
      },
      annotations: { readOnlyHint: true }
    },
    async ({ variant }) => {
      try {
        const results = await variantToTrials(variant);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}

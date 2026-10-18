import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { variantSearch, variantGet, fetchOncoKbAnnotation, getVariantSearchFilters } from '../../entities/variant.js';
import { variantToTrials } from '../../entities/cross-entity.js';
import { optionalNonEmptyString, requiredString, sliceArraysRecursive, withToolTimeout, type CancellationCapableExtra } from './utils.js';

// Deadline rationale (#107 phase 2): myvariant core lookup + parallel
// section wave (frequency/clinical/predictions, each with an 8s section
// deadline over 15s-per-attempt connections) — 40s covers the budget
// ceilings with headroom while bounding signal-ignoring stragglers.
const VARIANT_GET_TIMEOUT_MS = 40000;

const VARIANT_GET_SECTIONS = ['core', 'frequency', 'predictions', 'clinical', 'alphagenome_scores', 'all'] as const;
const VARIANT_SEARCH_FILTERS = getVariantSearchFilters();

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
        query: optionalNonEmptyString('Query').describe('Variant query (rsid or HGVS notation). Avoid compound queries like "BRAF V600E" — use gene + hgvsp parameters instead.'),
        gene: optionalNonEmptyString('Gene').describe('Filter by gene symbol (e.g., "BRAF"). Use together with hgvsp for protein change queries.'),
        significance: z.enum(['benign', 'likely_benign', 'pathogenic', 'likely_pathogenic', 'uncertain']).optional().describe('ClinVar significance category, matched exactly — records displayed as "Pathogenic/Likely pathogenic" match both pathogenic and likely_pathogenic; "Conflicting interpretations of pathogenicity" matches none of these'),
        max_frequency: z.number().optional().describe('Maximum allele frequency (0-1)'),
        min_cadd: z.number().optional().describe('Minimum CADD score; echoed per row as cadd_phred so the filter is verifiable from each result'),
        consequence: z.string().optional().describe('Variant consequence (e.g., missense, synonymous)'),
        rsid: optionalNonEmptyString('rsID').describe('dbSNP rsID'),
        hgvsp: optionalNonEmptyString('Protein change').describe('Protein change (e.g., V600E). Use with gene parameter for compound queries.'),
        hgvsc: optionalNonEmptyString('cDNA change').describe('cDNA change — bare c. notation (e.g., c.1799T>A) or full HGVS (e.g., NM_004333.4:c.1799T>A)'),
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

        if (!searchQuery && !searchGene && (rsid || hgvsp)) {
          // Compose the free-text query from the structured id filters, then
          // clear them so variantSearch does not double-push the same clauses
          // (mirrors the gene+hgvsp branch below). hgvsc deliberately stays
          // out of this composition: the entity layer routes it through the
          // HGVS rewrite, splitting full NM_...:c.... strings across
          // snpeff.ann.feature_id / snpeff.ann.hgvs_c — quoting them whole
          // matches nothing.
          const parts: string[] = [];
          if (rsid) parts.push(`dbsnp.rsid:${rsid}`);
          if (hgvsp) parts.push(`dbnsfp.hgvsp:*${hgvsp}*`);
          searchQuery = parts.join(' AND ');
          searchHgvsp = undefined;
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
      description: 'Get detailed variant information with optional sections. Core data (id, gene, rsid, significance) is always returned at the top level. Use sections to request additional data. Response section keys mirror the requested section names: sections:["alphagenome_scores"] returns sections.alphagenome_scores — the legacy storage key (alphagenome) never appears in responses.',
      inputSchema: {
        id: requiredString('Variant ID').describe('Variant ID (rsid e.g. rs113488022, HGVS e.g. NM_004333.4:c.1799T>A, ClinVar ID e.g. 13961 / clinvar_13961 / VCV0000013961). Multi-allelic rsIDs (one ClinVar allele per ALT, e.g. rs28934575): the top-level record is ONE allele, chosen by gnomad-availability — all alleles are returned under \'alleles\' with a \'_warning\' naming the reflected allele; to select an exact allele use allele-qualified HGVS (e.g. NM_000546.5:c.733G>T), where the transcript version must match the indexed snpeff annotation (NM_000546.5 works; ClinVar\'s NM_000546.6 does not)'),
        sections: z.array(z.enum(VARIANT_GET_SECTIONS)).optional().describe('Sections to include: core, frequency, predictions, clinical, alphagenome_scores (currently unavailable — returns an error stub pending AlphaGenome gRPC reimplementation)'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    async ({ id, sections, limit }, extra: CancellationCapableExtra) => {
      try {
        const result = await withToolTimeout(
          () => variantGet(id, sections),
          VARIANT_GET_TIMEOUT_MS,
          { signal: extra?.signal },
        );
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
          // #129: response keys mirror the requested (schema-advertised)
          // section names. The entity stores alphagenome_scores under the
          // legacy key 'alphagenome' so it can address it internally;
          // translate back at the tool boundary so callers can key on what
          // they asked for. In-repo entity consumers (variantToTrials,
          // batch_get) read entity output directly, below this remap, and
          // are unaffected. requestedSections already covers the 'all'
          // expansion; identity sections (no alias entry) are untouched.
          const sectionsOut = result.sections;
          for (const name of requestedSections) {
            const storedKey = VARIANT_STORAGE_KEYS[name];
            if (!storedKey || !(storedKey in sectionsOut)) continue;
            sectionsOut[name] = sectionsOut[storedKey];
            delete sectionsOut[storedKey];
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
        gene: requiredString('Gene symbol').describe('Gene symbol (e.g., BRAF, EGFR)'),
        protein_change: requiredString('Protein change').describe('Protein change (e.g., V600E, L858R)'),
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
        variant: requiredString('Variant ID').describe('Variant ID (rsID, HGVS, or variant ID)'),
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

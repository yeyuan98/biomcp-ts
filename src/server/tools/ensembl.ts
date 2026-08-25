import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ensemblLookup,
  ensemblHomology,
  ensemblConsequence,
  ensemblRegion,
} from '../../entities/ensembl.js';

export function registerEnsemblTools(server: McpServer): void {
  server.registerTool(
    'ensembl_lookup',
    {
      description: `Resolve a gene in Ensembl terms for ANY Ensembl species (356 available): stable ID (ENSG…), symbol↔ID mapping, versioned identifier, canonical transcript, and coordinates on the current assembly (GRCh38 human, GRCm39 mouse, …). With expand=true, returns all transcripts with translation/protein IDs.

Accepts an HGNC symbol (BRAF) or Ensembl gene ID (ENSG00000157764, versioned or bare — versions are resolved to the current record). Species accepts scientific names or aliases ('homo_sapiens'/'human', 'mus_musculus'/'mouse').
For rich human gene annotation (summary, pathways, drugs, diseases) use gene_get instead — this tool is the identifier/structure authority.`,
      inputSchema: {
        gene_or_id: z.string().describe('HGNC symbol (BRAF) or Ensembl gene ID (ENSG00000157764, versioned or bare)'),
        species: z.string().default('human').describe("Species name or alias — 'human' (default), 'mouse', 'mus_musculus', 'rat', …"),
        expand: z.boolean().default(false).describe('Include all transcripts with translation/protein IDs'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ gene_or_id, species, expand }) => {
      try {
        const result = await ensemblLookup(gene_or_id, { species, expand });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'ensembl_homology',
    {
      description: `Find orthologues or paralogues of a gene across species (Ensembl Compara) — the cross-species gene mapping source in biomcp.

Returns target stable IDs, species, taxonomy level, and percent identity, sorted by identity. Accepts an HGNC symbol or Ensembl gene ID; scope to one species with target_species ('mouse') or target_taxon (10090).
Use it for conservation questions ('is this gene conserved?', 'what is the mouse orthologue of BRAF?').`,
      inputSchema: {
        gene: z.string().describe('Gene symbol (BRAF) or Ensembl gene ID (ENSG00000157764)'),
        species: z.string().default('human').describe("Source species — 'human' (default), 'mouse', …"),
        type: z.enum(['orthologues', 'paralogues']).default('orthologues').describe('Homology type to fetch'),
        target_species: z.string().optional().describe("Restrict results to one species, e.g. 'mouse'"),
        target_taxon: z.number().int().optional().describe('Restrict results to a taxon ID, e.g. 10090 (Mus musculus)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum homologies to return (sorted by percent identity)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ gene, species, type, target_species, target_taxon, limit }) => {
      try {
        const result = await ensemblHomology(gene, { species, type, target_species, target_taxon, limit });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'ensembl_consequence',
    {
      description: `Predict the functional consequence of a variant on demand via Ensembl VEP — works even for NOVEL variants absent from every database, and for non-human species.

Input forms: HGVS c./p./g. notation ("NM_004333:c.1799T>A", "ENST00000288602:c.1799T>A") or a dbSNP rsID ("rs113488060").
Returns the most severe consequence plus per-transcript effects (impact, codon/amino-acid change, SIFT/PolyPhen where available) and co-located known variants (ClinVar/COSMIC IDs, gnomAD/1000G frequencies when present).
For KNOWN human variants, variant_get additionally provides deep pre-computed scores (CADD, REVEL, AlphaMissense, ClinVar stars) — prefer it there.`,
      inputSchema: {
        variant: z.string().describe('HGVS notation (NM_004333:c.1799T>A) or dbSNP rsID (rs113488060)'),
        species: z.string().default('human').describe("Species — 'human' (default), 'mouse', …"),
        limit: z.number().int().min(1).max(50).default(10).describe('Max transcript consequences returned (sorted by impact severity)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ variant, species, limit }) => {
      try {
        const result = await ensemblConsequence(variant, { species, limit });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'ensembl_region',
    {
      description: `Query what lives in a genomic interval on the current assembly (GRCh38 for human): genes/transcripts (stable IDs, symbols, biotypes) and known variants (rsIDs, alleles, consequence terms, clinical significance).

Ideal for locus triage — "what genes and known variants sit in this GWAS hit interval?".
Keep spans modest (<1 Mb recommended); output is capped at limit with a truncated marker. For sequence text use genbank_get; for entity-level annotation chain IDs into gene_get / variant_get.`,
      inputSchema: {
        region: z.string().describe('Genomic region chr:start-end (1-based, GRCh38 for human) — e.g. 7:140450000-140480000'),
        features: z
          .array(z.enum(['gene', 'transcript', 'variation']))
          .default(['gene', 'variation'])
          .describe('Feature types to include'),
        species: z.string().default('human').describe("Species — 'human' (default), 'mouse', …"),
        limit: z.number().int().min(1).max(500).default(50).describe('Maximum features returned'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ region, features, species, limit }) => {
      try {
        const result = await ensemblRegion(region, { features, species, limit });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}

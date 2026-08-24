import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { gtexMedianExpression, gtexEqtl } from '../../entities/gtex.js';

export function registerGtexTools(server: McpServer): void {
  server.registerTool(
    'gtex_expression',
    {
      description: `Get median gene expression across GTEx tissues (GTEx Analysis v10, 54 tissue sites, TPM, sorted highest first).

Accepts an HGNC symbol (TP53) or Ensembl gene ID (ENSG00000141510, versioned or bare). Optionally filter to a single tissue via its tissueSiteDetailId (e.g. Brain_Cortex, Whole_Blood).`,
      inputSchema: {
        gene: z.string().describe('HGNC symbol (TP53) or Ensembl gene ID (ENSG00000141510, versioned or bare)'),
        tissue: z.string().optional().describe('GTEx tissueSiteDetailId filter, e.g. Brain_Cortex, Whole_Blood'),
        limit: z.number().int().min(1).max(54).default(20).describe('Maximum tissues to return (highest expression first)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ gene, tissue, limit }) => {
      try {
        const result = await gtexMedianExpression(gene, { tissueSiteDetailId: tissue, limit });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );

  server.registerTool(
    'gtex_eqtl',
    {
      description: `Get significant cis-eQTL associations for a gene in a specific GTEx tissue (GTEx Analysis v10): variant_id, p_value, NES, and slope, sorted by ascending p-value.

tissue is a required GTEx tissueSiteDetailId (e.g. Whole_Blood, Brain_Cortex).`,
      inputSchema: {
        gene: z.string().describe('HGNC symbol (TP53) or Ensembl gene ID (ENSG00000141510, versioned or bare)'),
        tissue: z.string().describe('GTEx tissueSiteDetailId — required, e.g. Whole_Blood'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum associations to return'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ gene, tissue, limit }) => {
      try {
        const result = await gtexEqtl(gene, tissue, { limit });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error) }], isError: true };
      }
    }
  );
}

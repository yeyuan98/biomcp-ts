import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  analysisInputSchema,
  canonicalizeAnalysisInput,
  DEFAULT_TOP_N,
} from '../../ranalysis/validate.js';
import { runDeseq2, runEdger, runLimma, runSessionInfo } from '../../ranalysis/analyzers.js';
import { shutdownREngine } from '../../ranalysis/engine.js';

export function isAnalysisREnabled(): boolean {
  const v = process.env.ANALYSIS_R;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

function toResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

function toErrorResult(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }], isError: true };
}

const SHARED_INPUT = {
  counts: analysisInputSchema.shape.counts,
  coldata: analysisInputSchema.shape.coldata,
  design: analysisInputSchema.shape.design,
  contrast: analysisInputSchema.shape.contrast,
  coef: analysisInputSchema.shape.coef,
  top_n: analysisInputSchema.shape.top_n,
  include_full: analysisInputSchema.shape.include_full,
  format: analysisInputSchema.shape.format,
};

const SHARED_NOTES = `
**Input:** raw integer count matrix (genes x samples) plus per-sample metadata (\`coldata\`). Character metadata columns become factors and can be used in \`design\` (e.g. \`batch + condition\`) and \`contrast\`. Provide either \`contrast\` \`{variable, numerator, denominator}\` or \`coef\`; default is the last term of the design.
**Output:** markdown table of the top \`${'`top_n`'}\` genes by adjusted p-value (default ${DEFAULT_TOP_N}) plus a summary block; set \`format="json"\` for structured output and \`include_full=true\` to receive the complete table as base64(gzip(TSV)).
**Requirements:** first use starts a Wasm R runtime (~1 GB RSS) and downloads Bioconductor Wasm packages from this project's GitHub releases (set \`ANALYSIS_R_MIRROR_URL\` for offline use); \`npm install webr\` is required in local trees.`;

export function registerAnalysisRTools(server: McpServer): void {
  server.registerTool(
    'analysis_r_deseq2',
    {
      description:
        'Differential expression analysis of RNA-seq count data with Bioconductor DESeq2 (negative-binomial, variance-stabilizing shrinkage, independent filtering), running in a sandboxed WebAssembly R runtime.' +
        SHARED_NOTES,
      inputSchema: {
        ...SHARED_INPUT,
        alpha: z.number().min(0.001).max(0.2).optional().describe('Adjusted-p-value threshold for summary counts (default 0.05).'),
        fit_type: z.enum(['parametric', 'local', 'mean']).optional().describe('Dispersion fit type (default parametric).'),
        shrink: z
          .boolean()
          .optional()
          .describe('Apply DESeq2 lfcShrink(type="normal") to log2 fold changes (default false).'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ alpha, fit_type, shrink, ...rest }) => {
      try {
        const request = canonicalizeAnalysisInput(rest as Parameters<typeof canonicalizeAnalysisInput>[0]);
        const result = await runDeseq2(request, {
          alpha: alpha ?? 0.05,
          fitType: fit_type ?? 'parametric',
          shrink: shrink ?? false,
        });
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'analysis_r_edger',
    {
      description:
        'Differential expression analysis of RNA-seq count data with Bioconductor edgeR (TMM normalization, empirical Bayes dispersion, quasi-likelihood F-test or exact test), running in a sandboxed WebAssembly R runtime.' +
        SHARED_NOTES,
      inputSchema: {
        ...SHARED_INPUT,
        test: z.enum(['qlm', 'exact']).optional().describe('edgeR test: "qlm" quasi-likelihood (default, general designs) or "exact" (2-group exact test; requires contrast).'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ test, ...rest }) => {
      try {
        const request = canonicalizeAnalysisInput(rest as Parameters<typeof canonicalizeAnalysisInput>[0]);
        const result = await runEdger(request, { test: test ?? 'qlm' });
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'analysis_r_limma',
    {
      description:
        'Differential expression analysis of RNA-seq count data with limma-voom (TMM normalization via edgeR, precision-weighted linear models, empirical Bayes moderation), running in a sandboxed WebAssembly R runtime.' +
        SHARED_NOTES,
      inputSchema: { ...SHARED_INPUT },
      annotations: { readOnlyHint: false },
    },
    async (raw) => {
      try {
        const request = canonicalizeAnalysisInput(raw as Parameters<typeof canonicalizeAnalysisInput>[0]);
        const result = await runLimma(request);
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );

  server.registerTool(
    'analysis_r_session_info',
    {
      description:
        'Report the R analysis runtime status: R/WebAssembly version, installed Bioconductor package versions, library paths, memory usage, and the package mirror endpoint. Use this to diagnose analysis tool issues.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = await runSessionInfo();
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    }
  );
}

export function registerAnalysisRToolsIfConfigured(server: McpServer): boolean {
  if (!isAnalysisREnabled()) return false;
  registerAnalysisRTools(server);
  return true;
}

export { shutdownREngine };

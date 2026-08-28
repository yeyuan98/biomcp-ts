import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  OUTPUT_INPUT,
  PROJECTION_INPUT,
  REGION_INPUT,
  SOURCE_INPUT,
} from '../../biowasm/schemas.js';
import {
  canonicalizeOutput,
  canonicalizeProjection,
  canonicalizeSource,
  validateCliArgs,
} from '../../biowasm/validate.js';
import {
  runBamSummary,
  runBamViewRegion,
  runBcfSummary,
  runBcfViewRegion,
  runBedOp,
  runConvert,
  runBiowasmSessionInfo,
  runBiowasmCli,
} from '../../biowasm/analyzers.js';

export function isBiowasmEnabled(): boolean {
  const v = process.env.ANALYSIS_BIOWASM;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

function toResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

function toErrorResult(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }], isError: true };
}

const SOURCE_NOTES =
  '\n**Input:** `source` accepts inline `content` (BED/VCF/SAM text, format-sniffed), a prior `artifact_id` from any analysis_biowasm response, or a `host_path` under `ANALYSIS_BIOWASM_DATA_DIR` (unset = host files denied). Optional `index` supplies a sidecar explicitly or auto-detects `<file>.bai/.csi/.tbi/.crai` next to host files. ' +
  '**Output:** `format` "table" (markdown, `top_n` rows, 2 MB cap), "json" (structured), or "artifact" where supported (handle + preview; `include_content=true` inlines artifacts <= 2 MB as base64(gzip)). Every response embeds io_stats (bytes read, elapsed) for cost reasoning.';

export function registerBiowasmTools(server: McpServer): void {
  server.registerTool(
    'analysis_bam_summary',
    {
      description:
        'Inspect an alignment (SAM/BAM/CRAM) before deeper work — "what is in this BAM?": header contigs and lengths, sample and read groups, flagstat mapping metrics, and per-contig mapped/unmapped counts via idxstats when an index is available. Follow up with analysis_bam_view_region for loci of interest; analysis_biowasm_convert for format plumbing.' +
        SOURCE_NOTES,
      inputSchema: { ...SOURCE_INPUT, ...OUTPUT_INPUT },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (raw) => {
      try {
        const source = canonicalizeSource(raw.source, raw.index);
        const output = canonicalizeOutput(raw);
        const result = await runBamSummary(source, output);
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'analysis_bam_view_region',
    {
      description:
        'Reads, depth, or pileup in a genomic region of an alignment (samtools view/depth/mpileup): mode="count" answers "how many reads overlap this locus?" (index-driven, touches only the relevant index blocks); "depth" gives a per-base (optionally binned via depth_bins) coverage profile; "pileup" gives base-level pileup rows; "reads" returns SAM rows or, with format="artifact", a BAM artifact for downstream analysis_bed_op / analysis_biowasm_convert work. Region queries work on any source: indexed sources use fast positional retrieval; indexless sources stream through a synthesized BED region filter (-L/-b/-l), which for depth/pileup requires coordinate-sorted input (count/reads accept any order; unsorted depth fails with "Data is not position sorted"). Use analysis_bam_summary first to see contigs.' +
        SOURCE_NOTES,
      inputSchema: {
        ...SOURCE_INPUT,
        ...REGION_INPUT,
        mode: z.enum(['count', 'depth', 'pileup', 'reads']).default('count').describe('count = read count only (cheapest); depth = coverage profile; pileup = base-level pileup; reads = SAM rows or a BAM artifact'),
        depth_bins: z.number().int().min(1).max(1_000_000).optional().describe('Aggregate depth into bins of this many bp (mean depth per bin) instead of per-position rows.'),
        ...OUTPUT_INPUT,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (raw) => {
      try {
        const source = canonicalizeSource(raw.source, raw.index);
        const output = canonicalizeOutput(raw);
        const result = await runBamViewRegion(source, raw.region, raw.mode, raw.depth_bins, output);
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'analysis_bcf_summary',
    {
      description:
        'Inspect a VCF/BCF before querying variants — "what is in this variant file?": total variant record count, contigs, sample count and names (watch for cohort-scale files), and the full INFO/FORMAT field inventory from the header (bcftools view -h/-H; no index needed; with an index, per-contig record counts are included). Follow up with analysis_bcf_view_region to pull a narrow projection of variants.' +
        SOURCE_NOTES,
      inputSchema: { ...SOURCE_INPUT, ...OUTPUT_INPUT },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (raw) => {
      try {
        const source = canonicalizeSource(raw.source, raw.index);
        const output = canonicalizeOutput(raw);
        const result = await runBcfSummary(source, output);
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'analysis_bcf_view_region',
    {
      description:
        'Variants in a genomic region as a narrow field projection instead of raw VCF rows (bcftools query): pick columns (CHROM/POS/REF/ALT/…/GT), a `samples` subset (strongly recommended for cohort VCFs — the #1 context-reduction lever), an expression `filter` (e.g. \'INFO/DP>10 && QUAL>30\'), and variant_types. format="artifact" returns a sliced VCF.gz for analysis_biowasm_convert instead. Default response is a bounded table (top_n rows), never megabyte-wide rows.' +
        SOURCE_NOTES,
      inputSchema: {
        ...SOURCE_INPUT,
        ...REGION_INPUT,
        ...PROJECTION_INPUT,
        variant_types: z
          .array(z.enum(['snps', 'indels', 'mnps', 'other']))
          .max(4)
          .optional()
          .describe('Restrict to variant types (bcftools -v), e.g. ["snps"].'),
        ...OUTPUT_INPUT,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (raw) => {
      try {
        const source = canonicalizeSource(raw.source, raw.index);
        const output = canonicalizeOutput(raw);
        const result = await runBcfViewRegion(source, raw.region, canonicalizeProjection(raw.projection), raw.filter, raw.variant_types, output);
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'analysis_bed_op',
    {
      description:
        'Interval algebra on BED tracks (bedtools): intersect, merge, subtract, coverage, jaccard, or sort. Binary ops take `source` (A) and `b_source` (B) — pass b_source as an OBJECT like {"content": "chr1\\t10\\t20\\nchr1\\t100\\t200\\n"} or {"host_path": "..."}, never as a JSON-encoded string; set sorted_inputs=true for the memory-frugal -sorted algorithm on coordinate-sorted inputs (B-side inputs are otherwise loaded into the wasm heap — prefer sorted or bounded B). Produces a bounded table/json; pairs with analysis_bam_view_region artifacts and analysis_biowasm_convert.' +
        SOURCE_NOTES,
      inputSchema: {
        source: SOURCE_INPUT.source,
        b_source: SOURCE_INPUT.source.optional().describe('B interval track (required for intersect/subtract/coverage/jaccard).'),
        op: z.enum(['intersect', 'merge', 'subtract', 'coverage', 'jaccard', 'sort']).describe('Interval operation.'),
        sorted_inputs: z.boolean().default(false).describe('Inputs are coordinate-sorted; use the streaming -sorted algorithm.'),
        strand: z.boolean().default(false).describe('Strand-specific overlap (-s; intersect/coverage).'),
        fraction_overlap: z.number().min(0).max(1).optional().describe('Minimum overlap fraction (-f; intersect).'),
        ...OUTPUT_INPUT,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (raw) => {
      try {
        const a = canonicalizeSource(raw.source);
        const b = raw.b_source ? canonicalizeSource(raw.b_source) : undefined;
        const output = canonicalizeOutput(raw);
        const result = await runBedOp(
          raw.op,
          a,
          b,
          { sortedInputs: raw.sorted_inputs, strand: raw.strand, fraction: raw.fraction_overlap },
          output,
        );
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'analysis_biowasm_convert',
    {
      description:
        'Format plumbing between the biowasm tools: SAM/BAM/CRAM via samtools view, VCF/BCF via bcftools view, and VCF/BCF -> TSV via bcftools query with a field projection and optional filter. The input format is inferred from the source (inline content is sniffed); the result is an artifact handle (id, sha256, size, preview) reusable as artifact_id by every other analysis_biowasm tool — the glue for multi-step workflows (e.g. convert a BAM slice from analysis_bam_view_region, then summarize it with analysis_bam_summary). include_content=true inlines artifacts <= 2 MB as base64(gzip).' +
        SOURCE_NOTES,
      inputSchema: {
        ...SOURCE_INPUT,
        ...PROJECTION_INPUT,
        to: z.enum(['SAM', 'BAM', 'CRAM', 'VCF', 'BCF', 'TSV']).describe('Target format; the input format is inferred from the source.'),
        ...OUTPUT_INPUT,
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (raw) => {
      try {
        const source = canonicalizeSource(raw.source, raw.index);
        const output = canonicalizeOutput(raw);
        const result = await runConvert(source, raw.to, canonicalizeProjection(raw.projection), raw.filter, output);
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'analysis_biowasm_session_info',
    {
      description:
        'Biowasm runtime report: pinned samtools/bedtools/bcftools versions, asset cache location and verification time, engine status, retained artifact count, and process memory — for diagnosing analysis_biowasm_* issues. Read-only; never downloads assets or starts the worker.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const result = await runBiowasmSessionInfo();
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );

  server.registerTool(
    'analysis_biowasm_cli',
    {
      description:
        'Advanced escape hatch: run an allowlisted samtools/bedtools/bcftools subcommand directly (args are passed as an array to the tool — never through a shell). Prefer the workflow tools — analysis_bam_summary, analysis_bam_view_region, analysis_bcf_summary, analysis_bcf_view_region, analysis_bed_op, analysis_biowasm_convert — which validate inputs and bound outputs; use this only for subcommands they do not cover. Constraints: subcommand-level allowlist (phase 1), max 32 args, no shell metacharacters, no "..", paths only under /shared (inputs land in /shared/data; write outputs to /shared/out). Output captured with a 2 MB cap; io_stats included.',
      inputSchema: {
        tool: z.enum(['samtools', 'bedtools', 'bcftools']).describe('Which biowasm tool to run.'),
        args: z
          .array(z.string().min(1).max(512))
          .min(1)
          .max(32)
          .describe('Argument array starting with the subcommand, e.g. ["view", "-c", "/shared/data/in.sam", "chr1"].'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (raw) => {
      try {
        validateCliArgs(raw.tool, raw.args);
        const result = await runBiowasmCli(raw.tool, raw.args, { format: 'table', topN: 50, includeContent: false });
        return toResult(result.text);
      } catch (error) {
        return toErrorResult(error);
      }
    },
  );
}

export function registerBiowasmToolsIfConfigured(server: McpServer): boolean {
  if (!isBiowasmEnabled()) return false;
  registerBiowasmTools(server);
  return true;
}

export async function shutdownBiowasmEngine(): Promise<void> {
  const engineModule = await import('../../biowasm/engine.js');
  await engineModule.shutdownBiowasmEngine();
}

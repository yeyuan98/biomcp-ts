import { z } from 'zod';

export const LIMITS = {
  MAX_CONTENT_CHARS: 20 * 1024 * 1024,
  MAX_ARTIFACT_ID: 128,
  MAX_HOST_PATH: 512,
  MAX_REGION_BP: 100_000_000,
  MAX_SAMPLES: 10_000,
  MAX_FIELDS: 20,
  MAX_FILTER_EXPR: 512,
  MAX_TOP_N: 200,
  MAX_TEXT_BYTES: 2_097_152,
  MAX_HEAD_SAMPLE_BYTES: 262_144,
} as const;

export const DEFAULT_PROJECTION_FIELDS = ['CHROM', 'POS', 'REF', 'ALT'] as const;

export const sourceSchema = z
  .union([
    z.object({
      content: z.string().max(LIMITS.MAX_CONTENT_CHARS).describe('In-band file content (BED/VCF/SAM text); capped at 20 MiB'),
    }).strict(),
    z.object({
      artifact_id: z.string().max(LIMITS.MAX_ARTIFACT_ID).describe('artifact_id from a previous analysis_*_ tool response'),
    }).strict(),
    z.object({
      host_path: z.string().max(LIMITS.MAX_HOST_PATH).describe('Absolute path under ANALYSIS_BIOWASM_DATA_DIR (must be set)'),
    }).strict(),
  ])
  .describe(
    'Data source: inline content, prior artifact, or allowlisted host file (variants are strict — mixed-key objects are rejected, no silent stripping)',
  );

export const indexSchema = z
  .union([
    z.literal('auto'),
    z.object({ content: z.string().max(LIMITS.MAX_CONTENT_CHARS) }),
    z.object({ host_path: z.string().max(LIMITS.MAX_HOST_PATH) }),
  ])
  .default('auto')
  .describe('Index sidecar for indexed access (default "auto": try <file>.bai/.csi/.tbi/.crai)');

export const regionSchema = z
  .object({
    chrom: z.string().max(64).regex(/^[A-Za-z0-9_.*-]+$/),
    start: z.number().int().min(1).max(2_147_483_647).optional(),
    end: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .refine((r) => !r.start || !r.end || r.end >= r.start)
  .refine((r) => !r.start || !r.end || r.end - r.start <= LIMITS.MAX_REGION_BP)
  .describe('Region; omit start/end for whole contig');

export const fieldSchema = z
  .enum([
    'CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER',
    'INFO', 'AF', 'AC', 'AN', 'DP', 'TYPE', 'GT', 'GQ', 'DP_SAMPLE', 'AD',
  ])
  .describe('Output columns; the engine composes the query -f format string');

export const projectionSchema = z
  .object({
    fields: z.array(fieldSchema).min(1).max(LIMITS.MAX_FIELDS).default([...DEFAULT_PROJECTION_FIELDS]),
    samples: z
      .array(z.string().max(64))
      .max(LIMITS.MAX_SAMPLES)
      .optional()
      .describe('Sample subset (bcftools -s) — strongly recommended for cohort VCFs'),
  })
  .describe('Narrow projection instead of raw VCF rows');

export const filterSchema = z
  .string()
  .min(1)
  .max(LIMITS.MAX_FILTER_EXPR)
  .refine((s) => !/[;`$]/.test(s) && !/\b(system|exec|eval)\b/.test(s))
  .describe("bcftools expression, e.g. 'INFO/AF>0.01 && QUAL>30'");

export const outputSchema = z
  .object({
    format: z.enum(['table', 'json', 'artifact']).default('table'),
    top_n: z.number().int().min(1).max(LIMITS.MAX_TOP_N).default(50),
    include_content: z
      .boolean()
      .default(false)
      .describe('Inline artifact as base64(gzip) — only for artifacts <= 2 MB'),
  })
  .describe('Response shaping');

export type SourceInput = z.infer<typeof sourceSchema>;
export type IndexInput = z.infer<typeof indexSchema>;
export type RegionInput = z.infer<typeof regionSchema>;
export type FieldName = z.infer<typeof fieldSchema>;
export type ProjectionInput = z.infer<typeof projectionSchema>;
export type OutputInput = z.infer<typeof outputSchema>;

export const SHARED_INPUT = {
  source: sourceSchema,
  index: indexSchema,
  region: regionSchema,
  projection: projectionSchema.optional(),
  filter: filterSchema.optional(),
  format: outputSchema.shape.format,
  top_n: outputSchema.shape.top_n,
  include_content: outputSchema.shape.include_content,
} as const;

export const SOURCE_INPUT = {
  source: SHARED_INPUT.source,
  index: SHARED_INPUT.index,
} as const;

export const REGION_INPUT = {
  region: SHARED_INPUT.region,
} as const;

export const PROJECTION_INPUT = {
  projection: SHARED_INPUT.projection,
  filter: SHARED_INPUT.filter,
} as const;

export const OUTPUT_INPUT = {
  format: SHARED_INPUT.format,
  top_n: SHARED_INPUT.top_n,
  include_content: SHARED_INPUT.include_content,
} as const;

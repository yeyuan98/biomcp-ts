import { describe, it, expect } from '@jest/globals';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  LIMITS,
  DEFAULT_PROJECTION_FIELDS,
  sourceSchema,
  indexSchema,
  regionSchema,
  fieldSchema,
  projectionSchema,
  filterSchema,
  outputSchema,
  SHARED_INPUT,
} from '../../biowasm/schemas.js';

describe('biowasm shared schemas', () => {
  // Intentional drift guard: pins documented limits so deliberate changes
  // must touch this test; not a behavioral test.
  it('pins the exact limits', () => {
    expect(LIMITS.MAX_CONTENT_CHARS).toBe(20 * 1024 * 1024);
    expect(LIMITS.MAX_ARTIFACT_ID).toBe(128);
    expect(LIMITS.MAX_HOST_PATH).toBe(512);
    expect(LIMITS.MAX_REGION_BP).toBe(100_000_000);
    expect(LIMITS.MAX_SAMPLES).toBe(10_000);
    expect(LIMITS.MAX_FIELDS).toBe(20);
    expect(LIMITS.MAX_FILTER_EXPR).toBe(512);
    expect(LIMITS.MAX_TOP_N).toBe(200);
    expect(LIMITS.MAX_TEXT_BYTES).toBe(2_097_152);
    expect(LIMITS.MAX_HEAD_SAMPLE_BYTES).toBe(262_144);
  });

  it('accepts each source variant on its own', () => {
    expect(sourceSchema.safeParse({ content: 'chr1\t10\t20\n' }).success).toBe(true);
    expect(sourceSchema.safeParse({ artifact_id: 'bw1' }).success).toBe(true);
    expect(sourceSchema.safeParse({ host_path: '/data/a.bam' }).success).toBe(true);
  });

  it('rejects mixed-key and unknown-key sources (strict variants)', () => {
    expect(sourceSchema.safeParse({ content: 'x', artifact_id: 'bw1' }).success).toBe(false);
    expect(sourceSchema.safeParse({ content: 'x', host_path: '/data/a.bam' }).success).toBe(false);
    expect(sourceSchema.safeParse({ content: 'x', extra: 1 }).success).toBe(false);
    expect(sourceSchema.safeParse({}).success).toBe(false);
  });

  it('tolerates stringified-object sources (transparent JSON.parse)', () => {
    expect(sourceSchema.parse('{"content":"chr1\\t10\\t20\\n"}')).toEqual({ content: 'chr1\t10\t20\n' });
    expect(sourceSchema.parse('{"artifact_id":"bw1"}')).toEqual({ artifact_id: 'bw1' });
    expect(sourceSchema.parse('{"host_path":"/data/a.bam"}')).toEqual({ host_path: '/data/a.bam' });
    expect(indexSchema.parse('auto')).toBe('auto');
    expect(indexSchema.parse('{"content":"idx"}')).toEqual({ content: 'idx' });
    expect(indexSchema.parse('{"host_path":"/data/a.bam.bai"}')).toEqual({ host_path: '/data/a.bam.bai' });
  });

  it('rejects non-JSON strings with the descriptive preprocess message', () => {
    const message = 'Expected a JSON object like {"content": "..."}; received a string that is not valid JSON';
    expect(() => sourceSchema.parse('chr1\t10\t20\n')).toThrow(message);
    expect(() => sourceSchema.safeParse('{not json')).toThrow(message);
    expect(() => indexSchema.parse('nope')).toThrow(message);
  });

  it('still rejects stringified mixed-key sources (strict semantics survive the round-trip)', () => {
    expect(sourceSchema.safeParse('{"content":"x","artifact_id":"bw1"}').success).toBe(false);
    expect(sourceSchema.safeParse('{"content":"x","extra":1}').success).toBe(false);
  });

  it('emits the exact same JSON schema as the bare union (ZodPipe renders transparently)', () => {
    // Self-diagnosis for stale installs: z.toJSONSchema is the ONLY zod-4-only
    // API in the tree, so a node_modules predating the alpha.9 zod ^3→^4
    // upgrade fails here alone (src compiles against either major). Name the
    // resolved version instead of surfacing a bare TypeError (issue #222).
    if (typeof z.toJSONSchema !== 'function') {
      let resolved = 'unknown';
      try {
        resolved = JSON.parse(
          readFileSync(createRequire(import.meta.url).resolve('zod/package.json'), 'utf8'),
        ).version;
      } catch {
        // resolution itself failed; report 'unknown'
      }
      throw new Error(
        `Stale node_modules: resolved zod@${resolved}, but this suite needs zod ^4 (z.toJSONSchema). Run \`npm ci\` per docs/RELEASE.md step 9.`,
      );
    }
    // Mirrors the SDK's zod 4 compat path verbatim
    // (node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js
    // routes v4 schemas to zod/v4-mini toJSONSchema with target 'draft-7' and
    // io 'input' — its defaults when no target/pipeStrategy is passed). The
    // old zodToJsonSchema options (strictUnions/pipeStrategy) have no v4
    // equivalent: v4 unions always emit strict anyOf variants and io replaces
    // pipeStrategy.
    const opts = { target: 'draft-7', io: 'input' } as const;
    const bare = z
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
    const emitted = z.toJSONSchema(sourceSchema, opts);
    // zod 4's native emitter serializes the preprocess-wrapped and bare unions
    // with IDENTICAL content but different key order (the wrapped form emits
    // description before anyOf), so equality is structural (toEqual), not a
    // JSON.stringify byte comparison as under zod-to-json-schema.
    expect(emitted).toEqual(z.toJSONSchema(bare, opts));
    const json = emitted as { anyOf?: Array<Record<string, unknown>>; description?: string };
    expect(json.anyOf).toHaveLength(3);
    for (const variant of json.anyOf ?? []) expect(variant.additionalProperties).toBe(false);
    expect(json.description).toContain('strict');
  });

  it('caps in-band content at MAX_CONTENT_CHARS', () => {
    expect(sourceSchema.safeParse({ content: 'a'.repeat(LIMITS.MAX_CONTENT_CHARS) }).success).toBe(true);
    expect(sourceSchema.safeParse({ content: 'a'.repeat(LIMITS.MAX_CONTENT_CHARS + 1) }).success).toBe(false);
  });

  it('indexSchema defaults to auto and accepts content/host_path', () => {
    expect(indexSchema.parse(undefined)).toBe('auto');
    expect(indexSchema.safeParse({ content: 'idx' }).success).toBe(true);
    expect(indexSchema.safeParse({ host_path: '/data/a.bam.bai' }).success).toBe(true);
    expect(indexSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('regionSchema enforces chrom charset, order, and span', () => {
    expect(regionSchema.safeParse({ chrom: 'chr1' }).success).toBe(true);
    expect(regionSchema.safeParse({ chrom: 'chr1', start: 100, end: 200 }).success).toBe(true);
    expect(regionSchema.safeParse({ chrom: 'chr1 bad' }).success).toBe(false);
    expect(regionSchema.safeParse({ chrom: 'chr1', start: 0 }).success).toBe(false);
    expect(regionSchema.safeParse({ chrom: 'chr1', start: 200, end: 100 }).success).toBe(false);
    expect(regionSchema.safeParse({ chrom: 'chr1', start: 1, end: 1 + LIMITS.MAX_REGION_BP }).success).toBe(true);
    expect(regionSchema.safeParse({ chrom: 'chr1', start: 1, end: 2 + LIMITS.MAX_REGION_BP }).success).toBe(false);
  });

  it('filterSchema rejects denylisted characters and tokens', () => {
    expect(filterSchema.safeParse('INFO/AF>0.01 && QUAL>30').success).toBe(true);
    expect(filterSchema.safeParse('a;b').success).toBe(false);
    expect(filterSchema.safeParse('a$b').success).toBe(false);
    expect(filterSchema.safeParse('`x`').success).toBe(false);
    expect(filterSchema.safeParse('system("x")').success).toBe(false);
    expect(filterSchema.safeParse('exec(foo)').success).toBe(false);
    expect(filterSchema.safeParse('eval(x)').success).toBe(false);
    expect(filterSchema.safeParse('a'.repeat(LIMITS.MAX_FILTER_EXPR + 1)).success).toBe(false);
  });

  it('outputSchema applies its defaults and caps', () => {
    expect(outputSchema.parse({})).toEqual({ format: 'table', top_n: 50, include_content: false });
    expect(outputSchema.safeParse({ format: 'xml' }).success).toBe(false);
    expect(outputSchema.safeParse({ top_n: 201 }).success).toBe(false);
    expect(outputSchema.safeParse({ top_n: 0 }).success).toBe(false);
  });

  it('fieldSchema enumerates the 17 projection fields', () => {
    expect(fieldSchema.options).toHaveLength(17);
    expect(fieldSchema.options).toContain('DP_SAMPLE');
  });

  it('projectionSchema defaults fields and caps arrays', () => {
    expect(projectionSchema.parse({}).fields).toEqual([...DEFAULT_PROJECTION_FIELDS]);
    expect(projectionSchema.safeParse({ fields: [] }).success).toBe(false);
    expect(projectionSchema.safeParse({ fields: Array<string>(21).fill('CHROM') }).success).toBe(false);
    expect(projectionSchema.safeParse({ samples: Array<string>(LIMITS.MAX_SAMPLES + 1).fill('s') }).success).toBe(false);
  });

  it('exposes SHARED_INPUT as raw zod shapes for registerTool spreading', () => {
    expect(Object.keys(SHARED_INPUT)).toEqual([
      'source',
      'index',
      'region',
      'projection',
      'filter',
      'format',
      'top_n',
      'include_content',
    ]);
    for (const shape of Object.values(SHARED_INPUT)) {
      expect(typeof (shape as { safeParse: unknown }).safeParse).toBe('function');
    }
  });
});

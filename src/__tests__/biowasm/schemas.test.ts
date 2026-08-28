import { describe, it, expect } from '@jest/globals';
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

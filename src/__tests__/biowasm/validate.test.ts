import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeProjection,
  canonicalizeSource,
  composeQueryFormat,
  formatRegion,
  resolveHostDataPath,
  sniffTextFormat,
  validateCliArgs,
  ValidationError,
} from '../../biowasm/validate.js';
import { registerArtifact } from '../../biowasm/artifacts.js';

const SAVED_DATA_DIR = process.env.ANALYSIS_BIOWASM_DATA_DIR;
const SAVED_CACHE_DIR = process.env.BIOMCP_CACHE_DIR;

const WORK = join(tmpdir(), `biomcp-biowasm-validate-${Date.now()}`);

beforeEach(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, 'data'), { recursive: true });
  delete process.env.ANALYSIS_BIOWASM_DATA_DIR;
  process.env.BIOMCP_CACHE_DIR = join(WORK, 'cache');
});

afterEach(() => {
  if (SAVED_DATA_DIR === undefined) delete process.env.ANALYSIS_BIOWASM_DATA_DIR;
  else process.env.ANALYSIS_BIOWASM_DATA_DIR = SAVED_DATA_DIR;
  if (SAVED_CACHE_DIR === undefined) delete process.env.BIOMCP_CACHE_DIR;
  else process.env.BIOMCP_CACHE_DIR = SAVED_CACHE_DIR;
  rmSync(WORK, { recursive: true, force: true });
});

describe('host_path sandbox', () => {
  it('rejects host_path when ANALYSIS_BIOWASM_DATA_DIR is unset', () => {
    expect(() => resolveHostDataPath('/data/a.bam')).toThrow(ValidationError);
    expect(() => resolveHostDataPath('/data/a.bam')).toThrow(/ANALYSIS_BIOWASM_DATA_DIR/);
  });

  it('rejects paths outside the allowlist root', () => {
    process.env.ANALYSIS_BIOWASM_DATA_DIR = join(WORK, 'data');
    expect(() => resolveHostDataPath('/etc/passwd')).toThrow(ValidationError);
    expect(() => resolveHostDataPath(join(WORK, 'elsewhere', 'a.bam'))).toThrow(/outside/);
  });

  it('rejects embedded .. escapes even inside the root', () => {
    process.env.ANALYSIS_BIOWASM_DATA_DIR = join(WORK, 'data');
    const rawWithDotDot = `${join(WORK, 'data')}/../secret.txt`;
    expect(rawWithDotDot).toContain('..');
    expect(() => resolveHostDataPath(rawWithDotDot)).toThrow(/\.\./);
  });

  it('rejects prefix-sibling roots (no string-prefix bypass)', () => {
    process.env.ANALYSIS_BIOWASM_DATA_DIR = join(WORK, 'data');
    mkdirSync(join(WORK, 'data-evil'), { recursive: true });
    writeFileSync(join(WORK, 'data-evil', 'a.bam'), 'x');
    expect(() => resolveHostDataPath(join(WORK, 'data-evil', 'a.bam'))).toThrow(/outside/);
  });

  it('accepts and resolves paths inside the root', () => {
    process.env.ANALYSIS_BIOWASM_DATA_DIR = join(WORK, 'data');
    writeFileSync(join(WORK, 'data', 'a.bam'), 'x');
    const resolved = resolveHostDataPath(join(WORK, 'data', 'a.bam'));
    expect(resolved).toBe(join(WORK, 'data', 'a.bam'));
  });
});

describe('region formatting', () => {
  it('formats without commas and omits missing bounds', () => {
    expect(formatRegion({ chrom: 'chr1' })).toBe('chr1');
    expect(formatRegion({ chrom: 'chr1', start: 100, end: 200 })).toBe('chr1:100-200');
    expect(formatRegion({ chrom: 'chr1', start: 1_000_000, end: 2_000_000 })).toBe('chr1:1000000-2000000');
    expect(formatRegion({ chrom: 'chr1', start: 500 })).toBe('chr1:500');
    expect(formatRegion({ chrom: 'chr1', end: 900 })).toBe('chr1:1-900');
  });
});

describe('projection format-string composition', () => {
  it('builds the exact bcftools query -f string for the default projection', () => {
    expect(composeQueryFormat(canonicalizeProjection().fields)).toBe('%CHROM\t%POS\t%REF\t%ALT\n');
    expect(composeQueryFormat(['CHROM', 'POS', 'REF', 'ALT'])).toBe('%CHROM\t%POS\t%REF\t%ALT\n');
  });

  it('maps INFO tags and bracketed sample fields exactly', () => {
    expect(composeQueryFormat(['CHROM', 'POS', 'AF', 'DP', 'TYPE'])).toBe('%CHROM\t%POS\t%INFO/AF\t%INFO/DP\t%TYPE\n');
    expect(composeQueryFormat(['CHROM', 'POS', 'GT', 'GQ', 'DP_SAMPLE', 'AD'])).toBe('%CHROM\t%POS\t[%GT]\t[%GQ]\t[%DP]\t[%AD]\n');
    expect(composeQueryFormat(['ID', 'QUAL', 'FILTER', 'INFO'])).toBe('%ID\t%QUAL\t%FILTER\t%INFO\n');
  });

  it('applies the default fields when no projection is given', () => {
    expect(canonicalizeProjection()).toEqual({ fields: ['CHROM', 'POS', 'REF', 'ALT'], samples: undefined });
    expect(canonicalizeProjection({ samples: ['s1'] })).toEqual({ fields: ['CHROM', 'POS', 'REF', 'ALT'], samples: ['s1'] });
  });
});

describe('content sniffing and source canonicalization', () => {
  it('sniffs SAM, VCF, and BED text', () => {
    expect(sniffTextFormat('@HD\tVN:1.6\n@SQ\tSN:chr1\tLN:1000\n')).toBe('sam');
    expect(sniffTextFormat('##fileformat=VCFv4.2\n#CHROM\tPOS\n')).toBe('vcf');
    expect(sniffTextFormat('chr1\t10\t20\n')).toBe('bed');
    expect(sniffTextFormat('hello world')).toBe('text');
  });

  it('canonicalizes in-band content to an engine input with a sniffed name', () => {
    const resolved = canonicalizeSource({ content: '@HD\tVN:1.6\n' });
    expect(resolved.kind).toBe('content');
    expect(resolved.inputs).toHaveLength(1);
    expect(resolved.inputs[0].name).toMatch(/^in-[0-9a-f]{12}\.sam$/);
    expect(resolved.vfsPath).toBe(`/shared/data/${resolved.inputs[0].name}`);
    expect(resolved.mounts).toEqual([]);
    expect(resolved.hasIndex).toBe(false);
  });

  it('writes an explicit content index as a sibling input', () => {
    const resolved = canonicalizeSource({ content: '@HD\tVN:1.6\n' }, { content: 'BAI bytes' });
    expect(resolved.inputs).toHaveLength(2);
    expect(resolved.inputs[1].name).toBe(`${resolved.inputs[0].name}.bai`);
    expect(resolved.hasIndex).toBe(true);
  });

  it('canonicalizes artifact_id through the registry into a host mount', () => {
    const artifactHost = join(WORK, 'cache', 'biowasm-artifacts', 'toy.bam');
    mkdirSync(join(WORK, 'cache', 'biowasm-artifacts'), { recursive: true });
    writeFileSync(artifactHost, 'BAM');
    const record = registerArtifact({ hostPath: artifactHost, size: 3, sha256: null, tool: 'samtools', description: 'test' });
    const resolved = canonicalizeSource({ artifact_id: record.id });
    expect(resolved.kind).toBe('artifact');
    expect(resolved.mounts).toHaveLength(1);
    expect(resolved.mounts[0].hostPath).toBe(artifactHost);
    expect(resolved.mounts[0].vfsPath).toMatch(/^\/shared\/data\/[0-9a-f]{8}-toy\.bam$/);
  });

  it('rejects unknown artifact ids', () => {
    expect(() => canonicalizeSource({ artifact_id: 'nope' })).toThrow(ValidationError);
  });

  it('auto-detects sibling indexes for host mounts', () => {
    process.env.ANALYSIS_BIOWASM_DATA_DIR = join(WORK, 'data');
    writeFileSync(join(WORK, 'data', 'a.bam'), 'x');
    writeFileSync(join(WORK, 'data', 'a.bam.bai'), 'y');
    const resolved = canonicalizeSource({ host_path: join(WORK, 'data', 'a.bam') });
    expect(resolved.kind).toBe('host_path');
    expect(resolved.hasIndex).toBe(true);
    expect(resolved.mounts).toHaveLength(2);
    expect(resolved.mounts[1].vfsPath).toBe(`${resolved.mounts[0].vfsPath}.bai`);
  });

  it('mounts an explicit host_path index next to the main file', () => {
    process.env.ANALYSIS_BIOWASM_DATA_DIR = join(WORK, 'data');
    writeFileSync(join(WORK, 'data', 'a.bam'), 'x');
    writeFileSync(join(WORK, 'data', 'custom.csi'), 'y');
    const resolved = canonicalizeSource({ host_path: join(WORK, 'data', 'a.bam') }, { host_path: join(WORK, 'data', 'custom.csi') });
    expect(resolved.hasIndex).toBe(true);
    expect(resolved.mounts[1].vfsPath).toBe(`${resolved.mounts[0].vfsPath}.csi`);
  });
});

describe('cli arg validation', () => {
  it('rejects subcommands off the allowlist', () => {
    expect(() => validateCliArgs('samtools', ['view', '-c', 'a'])).not.toThrow();
    expect(() => validateCliArgs('samtools', ['rmrf', '/'])).toThrow(/allowlist/);
    expect(() => validateCliArgs('bedtools', ['intersect'])).not.toThrow();
    expect(() => validateCliArgs('bcftools', ['query', '-f', '%POS\n'])).not.toThrow();
  });

  it('rejects shell metacharacters, .. segments, and non-/shared paths', () => {
    expect(() => validateCliArgs('samtools', ['view', '-c', 'a;b'])).toThrow(/metacharacter/);
    expect(() => validateCliArgs('samtools', ['view', '-c', '`x`'])).toThrow(/metacharacter/);
    expect(() => validateCliArgs('samtools', ['view', '/shared/data/../x.sam'])).toThrow(/\.\./);
    expect(() => validateCliArgs('samtools', ['view', '/etc/passwd'])).toThrow(/\/shared/);
    expect(() => validateCliArgs('samtools', ['view', 'a.bam'])).toThrow(/\/shared/);
  });

  it('accepts /shared paths and bare non-path args', () => {
    expect(() => validateCliArgs('samtools', ['view', '-c', '/shared/data/a.bam', 'chr1:100-200'])).not.toThrow();
    expect(() => validateCliArgs('bedtools', ['merge', '-i', '/shared/data/a.bed'])).not.toThrow();
  });

  it('enforces the arg count cap', () => {
    const args = ['view', ...Array<string>(32).fill('x')];
    expect(() => validateCliArgs('samtools', args)).toThrow(/32/);
  });
});

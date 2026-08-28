import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { BiowasmRunResult } from '../../biowasm/engine.js';
import { canonicalizeSource, type ResolvedSource } from '../../biowasm/validate.js';

// ---------------------------------------------------------------------------
// Mocked engine: analyzers dynamically imports ./engine.js, so the mock is
// resolved for that specifier too (same pattern as engine.test.ts).
// ---------------------------------------------------------------------------

type RunRequest = Parameters<typeof import('../../biowasm/engine.js')['biowasmEngine']['run']>[0];
const runMock = jest.fn<(request: RunRequest) => Promise<BiowasmRunResult>>();

jest.unstable_mockModule('../../biowasm/engine.js', () => ({
  biowasmEngine: {
    run: (request: RunRequest) => runMock(request),
    assetsDirectory: () => null,
    ensureReady: async () => undefined,
    shutdown: async () => undefined,
  },
  shutdownBiowasmEngine: async () => undefined,
}));

function runResult(over: Partial<BiowasmRunResult> = {}): BiowasmRunResult {
  return {
    exitCode: 0,
    stdout: { mode: 'capture', text: '', truncated: false },
    stderr: '',
    outputs: [],
    ioStats: {},
    heapBytes: 16 * 1024 * 1024,
    ms: 1,
    ...over,
  };
}

function countResult(lines: number, text = ''): BiowasmRunResult {
  return runResult({
    stdout: { mode: 'count', chars: text.length, lines, head: text, tail: text, truncated: false },
  });
}

function hostSource(over: Partial<ResolvedSource> = {}): ResolvedSource {
  return {
    kind: 'host_path',
    label: 'toy.bam',
    vfsPath: '/shared/data/toy.bam',
    inputs: [],
    mounts: [{ hostPath: '/host/toy.bam', vfsPath: '/shared/data/toy.bam' }],
    hasIndex: false,
    approxBytes: 0,
    ...over,
  };
}

describe('biowasm analyzers failure semantics (engine mocked)', () => {
  let analyzers: typeof import('../../biowasm/analyzers.js');

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    analyzers = await import('../../biowasm/analyzers.js');
  });

  describe('looksFailed pattern table', () => {
    it('flags any non-null nonzero exit code, even with clean stderr', () => {
      expect(analyzers.looksFailed(runResult({ exitCode: 1 }))).toBe(true);
      expect(analyzers.looksFailed(runResult({ exitCode: 2 }))).toBe(true);
      expect(analyzers.looksFailed(runResult({ exitCode: 127 }))).toBe(true);
    });

    it.each([
      ['[E::idx_find_and_load] Could not retrieve index file for \'/shared/data/a.bam\''],
      ['[E::hts_open_format] Failed to open file "x" : No such file or directory'],
      ['Error: something went catastrophically wrong'],
      ['samtools view: Could not read file "/shared/data/a.bam"'],
      ['samtools depth: Data is not position sorted'],
      ['bcftools query: Failed to open "/shared/data/a.vcf"'],
      ['[main_samview] invalid region "chrZ:1-10"'],
      ['a benign first line\n[E::late_sibling] fatal on a later line'],
    ])('treats fatal stderr as failure at exit code 0: %s', (stderr) => {
      expect(analyzers.looksFailed(runResult({ exitCode: 0, stderr }))).toBe(true);
    });

    it.each([
      ['[W::hts_idx_load3] The index file is older than the data file'],
      ['[mpileup] 1 samples in 1 input files'],
      ['[mpileup] 254 samples in 1 input files'],
      ['Could not load index for VCF: /shared/data/a.vcf'],
      [''],
    ])('treats benign stderr as success at exit code 0: %s', (stderr) => {
      expect(analyzers.looksFailed(runResult({ exitCode: 0, stderr }))).toBe(false);
    });

    it('never coerces a null status to failure by itself, but still checks stderr', () => {
      expect(analyzers.looksFailed(runResult({ exitCode: null }))).toBe(false);
      expect(analyzers.looksFailed(runResult({ exitCode: null, stderr: '[E::boom] x' }))).toBe(true);
    });
  });

  describe('requireSuccess atomicity', () => {
    it('throws on nonzero rc, on rc=0 with fatal stderr, and passes rc=0 clean', () => {
      expect(() => analyzers.requireSuccess(runResult({ exitCode: 1, stderr: 'x' }), 'step')).toThrow(
        /step failed \(exit code 1\)/,
      );
      expect(() =>
        analyzers.requireSuccess(
          runResult({ exitCode: 0, stderr: '[E::idx_find_and_load] nope' }),
          'samtools idxstats',
        ),
      ).toThrow(/samtools idxstats failed \(exit code 0\).*\[E::idx_find_and_load\]/s);
      const clean = runResult({ exitCode: 0 });
      expect(analyzers.requireSuccess(clean, 'step')).toBe(clean);
    });

    it('does not throw on a null exit code with clean stderr (never coerced to 0)', () => {
      const res = runResult({ exitCode: null });
      expect(analyzers.requireSuccess(res, 'step')).toBe(res);
    });
  });

  describe('analysis_biowasm_cli raw path (never throws)', () => {
    it('renders a nonzero-rc failure with is_error and stderr instead of throwing', async () => {
      runMock.mockResolvedValue(
        runResult({
          exitCode: 1,
          stderr:
            '[E::hts_open_format] Failed to open file "/shared/data/missing.bam" : No such file or directory\n' +
            'samtools view: failed to open "/shared/data/missing.bam"',
        }),
      );
      const result = await analyzers.runBiowasmCli('samtools', ['view', '-c', '/shared/data/missing.bam'], {
        format: 'table',
        topN: 50,
        includeContent: false,
      });
      expect(result.text).toContain('| exit code | 1 |');
      expect(result.text).toContain('| is_error | true |');
      expect(result.text).toContain('**error:** the tool reported a failure');
      expect(result.text).toContain('[E::hts_open_format]');
    });

    it('reports is_error and exit_code in json format', async () => {
      runMock.mockResolvedValue(runResult({ exitCode: 1, stderr: 'samtools view: boom' }));
      const result = await analyzers.runBiowasmCli('samtools', ['view'], { format: 'json', topN: 50, includeContent: false });
      const parsed = JSON.parse(result.text) as { exit_code: number | null; is_error: boolean; stderr: string };
      expect(parsed.exit_code).toBe(1);
      expect(parsed.is_error).toBe(true);
      expect(parsed.stderr).toContain('boom');
    });

    it('renders a null exit code as "unknown (no status)"', async () => {
      runMock.mockResolvedValue(runResult({ exitCode: null }));
      const result = await analyzers.runBiowasmCli('samtools', ['stats', '/shared/data/a.bam'], { format: 'table', topN: 50, includeContent: false });
      expect(result.text).toContain('| exit code | unknown (no status) |');
      expect(result.text).toContain('| is_error | false |');
    });

    it('marks successful runs is_error false', async () => {
      runMock.mockResolvedValue(runResult({ exitCode: 0, stdout: { mode: 'capture', text: 'ok', truncated: false } }));
      const result = await analyzers.runBiowasmCli('samtools', ['stats', '/shared/data/a.bam'], { format: 'table', topN: 50, includeContent: false });
      expect(result.text).toContain('| exit code | 0 |');
      expect(result.text).toContain('| is_error | false |');
    });
  });

  describe('analysis_bam_view_region dispatch', () => {
    const sam = ['@HD\tVN:1.6\tSO:coordinate', '@SQ\tSN:chr1\tLN:1000', '@SQ\tSN:chr2\tLN:1000'].join('\n') + '\n';

    it('uses positional -r args on an indexed source and never stages a BED', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: '2', truncated: false } }));
      await analyzers.runBamViewRegion(
        hostSource({ hasIndex: true }),
        { chrom: 'chr1', start: 90, end: 220 },
        'count',
        undefined,
        { format: 'json', topN: 50, includeContent: false },
      );
      const req = runMock.mock.calls[0][0];
      expect(req.args).toEqual(['view', '-c', '/shared/data/toy.bam', 'chr1:90-220']);
      expect(req.inputs).toEqual([]);
    });

    it('stages a BED and switches count to -L on an indexless source', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: '1', truncated: false } }));
      const source = canonicalizeSource({ content: sam });
      const result = await analyzers.runBamViewRegion(
        source,
        { chrom: 'chr2' },
        'count',
        undefined,
        { format: 'json', topN: 50, includeContent: false },
      );
      const req = runMock.mock.calls[0][0];
      // Whole-contig region with a header-known LN: end comes from @SQ LN, not the huge clamp.
      expect(req.args).toEqual(['view', '-c', '-L', '/shared/data/region-chr2_1_1000.bed', source.vfsPath]);
      expect(req.inputs).toHaveLength(2);
      expect(req.inputs![1]).toEqual({ name: 'region-chr2_1_1000.bed', content: 'chr2\t0\t1000\n' });
      const parsed = JSON.parse(result.text) as { reads: number };
      expect(parsed.reads).toBe(1);
    });

    it('falls back to the huge clamped end for whole-contig regions without a parseable header', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: '2', truncated: false } }));
      await analyzers.runBamViewRegion(
        hostSource(),
        { chrom: 'chr1' },
        'count',
        undefined,
        { format: 'json', topN: 50, includeContent: false },
      );
      const req = runMock.mock.calls[0][0];
      expect(req.inputs![0]).toEqual({ name: 'region-chr1_1_2147483647.bed', content: 'chr1\t0\t2147483647\n' });
    });

    it('maps depth to -b, pileup to -l, and reads to -L on indexless sources', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: 'chr1\t100\t1', truncated: false } }));
      const source = canonicalizeSource({ content: sam });
      const output = { format: 'table' as const, topN: 50, includeContent: false };

      await analyzers.runBamViewRegion(source, { chrom: 'chr1', start: 90, end: 220 }, 'depth', undefined, output);
      expect(runMock.mock.calls[0][0].args).toEqual(['depth', '-a', '-b', '/shared/data/region-chr1_90_220.bed', source.vfsPath]);
      expect(runMock.mock.calls[0][0].inputs![1]!.content).toBe('chr1\t89\t220\n');

      await analyzers.runBamViewRegion(source, { chrom: 'chr1', start: 90, end: 220 }, 'pileup', undefined, output);
      expect(runMock.mock.calls[1][0].args).toEqual(['mpileup', '-l', '/shared/data/region-chr1_90_220.bed', source.vfsPath]);

      await analyzers.runBamViewRegion(source, { chrom: 'chr1', start: 90, end: 220 }, 'reads', undefined, output);
      expect(runMock.mock.calls[2][0].args).toEqual(['view', '-L', '/shared/data/region-chr1_90_220.bed', source.vfsPath]);

      // Indexed sources keep the proven positional -r forms.
      await analyzers.runBamViewRegion(hostSource({ hasIndex: true }), { chrom: 'chr1', start: 90, end: 220 }, 'depth', undefined, output);
      expect(runMock.mock.calls[3][0].args).toEqual(['depth', '-a', '-r', 'chr1:90-220', '/shared/data/toy.bam']);
      expect(runMock.mock.calls[3][0].inputs).toEqual([]);
    });
  });

  describe('analysis_bcf_summary record counts', () => {
    const vcfHeader = '##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n';

    it('always runs the view -H counting pass and reports variant_count', async () => {
      runMock
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: vcfHeader, truncated: false } }))
        .mockResolvedValueOnce(countResult(2));
      const source = hostSource();
      const result = await analyzers.runBcfSummary(source, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(2);
      expect(runMock.mock.calls[1]![0].args).toEqual(['view', '-H', source.vfsPath]);
      expect(runMock.mock.calls[1]![0].stdout).toBe('count');
      const parsed = JSON.parse(result.text) as { variant_count: number; records_per_contig?: unknown };
      expect(parsed.variant_count).toBe(2);
      expect(parsed.records_per_contig).toBeUndefined();
    });

    it('skips the index -s pass without an index and includes per-contig records with one', async () => {
      runMock
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: vcfHeader, truncated: false } }))
        .mockResolvedValueOnce(countResult(2))
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: 'chr1\t1000\t2\nchr2\t1000\t1', truncated: false } }));
      const source = hostSource({ hasIndex: true });

      const json = await analyzers.runBcfSummary(source, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(3);
      expect(runMock.mock.calls[2]![0].args).toEqual(['index', '-s', source.vfsPath]);
      const parsed = JSON.parse(json.text) as { records_per_contig: Array<{ contig: string; length: number; records: number }> };
      expect(parsed.records_per_contig).toEqual([
        { contig: 'chr1', length: 1000, records: 2 },
        { contig: 'chr2', length: 1000, records: 1 },
      ]);

      runMock.mockClear();
      runMock
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: vcfHeader, truncated: false } }))
        .mockResolvedValueOnce(countResult(2))
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: 'chr1\t1000\t2', truncated: false } }));
      const table = await analyzers.runBcfSummary(source, { format: 'table', topN: 50, includeContent: false });
      expect(table.text).toContain('| variants | 2 |');
      expect(table.text).toContain('Records per contig');
      expect(table.text).toContain('| chr1 | 1000 | 2 |');
    });
  });
});

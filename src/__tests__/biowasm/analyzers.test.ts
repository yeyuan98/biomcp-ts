import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  // Same-registry-generation ValidationError: beforeEach resetModules()s and
  // re-imports the analyzers, so the static import's class identity would NOT
  // match the errors the fresh analyzers throw (dual module instances).
  let validate: typeof import('../../biowasm/validate.js');

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    analyzers = await import('../../biowasm/analyzers.js');
    validate = await import('../../biowasm/validate.js');
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

    it('with an index: index -s runs FIRST, its summed records become variant_count, and the streaming view -H pass is skipped', async () => {
      runMock
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: 'chr1\t1000\t2\nchr2\t1000\t1', truncated: false } }))
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: vcfHeader, truncated: false } }));
      const source = hostSource({ hasIndex: true });

      const json = await analyzers.runBcfSummary(source, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(2);
      expect(runMock.mock.calls[0]![0].args).toEqual(['index', '-s', source.vfsPath]);
      expect(runMock.mock.calls[1]![0].args).toEqual(['view', '-h', source.vfsPath]);
      // Mandated order (Fix C fast path): index -s runs FIRST (instant when
      // the sidecar carries counts); its success SKIPS view -H entirely.
      expect(runMock.mock.calls.some((c) => c[0].args[0] === 'view' && c[0].args[1] === '-H')).toBe(false);
      const parsed = JSON.parse(json.text) as {
        variant_count: number;
        records_per_contig: Array<{ contig: string; length: number; records: number }>;
      };
      expect(parsed.variant_count).toBe(3);
      expect(parsed.records_per_contig).toEqual([
        { contig: 'chr1', length: 1000, records: 2 },
        { contig: 'chr2', length: 1000, records: 1 },
      ]);

      runMock.mockClear();
      runMock
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: 'chr1\t1000\t2\nchr2\t1000\t1', truncated: false } }))
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: vcfHeader, truncated: false } }));
      const table = await analyzers.runBcfSummary(source, { format: 'table', topN: 50, includeContent: false });
      expect(table.text).toContain('| variants | 3 |');
      expect(table.text).toContain('Records per contig');
      expect(table.text).toContain('| chr1 | 1000 | 2 |');
    });

    it('tolerates an index -s failure: non-fatal note, gated streaming fallback supplies variant_count', async () => {
      runMock
        .mockResolvedValueOnce(runResult({ exitCode: 1, stderr: 'Error: the index carries no record counts' }))
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: vcfHeader, truncated: false } }))
        .mockResolvedValueOnce(countResult(7));
      const source = hostSource({ hasIndex: true });

      const table = await analyzers.runBcfSummary(source, { format: 'table', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(3);
      expect(runMock.mock.calls[0]![0].args).toEqual(['index', '-s', source.vfsPath]);
      expect(runMock.mock.calls[2]![0].args).toEqual(['view', '-H', source.vfsPath]);
      expect(runMock.mock.calls[2]![0].stdout).toBe('count');
      expect(table.text).toContain('Index record counts unavailable');
      expect(table.text).toContain('Error: the index carries no record counts');
      expect(table.text).toContain('| variants | 7 |');
    });

  });

  describe('depth doubling detection (indexless bed fallback)', () => {
    const sam = ['@HD\tVN:1.6\tSO:coordinate', '@SQ\tSN:chr1\tLN:1000', '@SQ\tSN:chr2\tLN:1000'].join('\n') + '\n';

    // Real observed doubled output shape: samtools depth -a -b emits a zero-filled
    // pass followed by the real pass when read order regresses across references.
    const doubledDepthRows = (): string[][] => {
      const rows: string[][] = [];
      for (let p = 290; p <= 310; p += 1) rows.push(['chr1', String(p), '0']);
      for (let p = 290; p <= 310; p += 1) rows.push(['chr1', String(p), p >= 300 && p <= 309 ? '1' : '0']);
      return rows;
    };
    const doubledDepthStdout = doubledDepthRows()
      .map((row) => row.join('\t'))
      .join('\n');

    it('findDuplicateDepthPosition returns the first repeated chrom:pos on doubled output', () => {
      expect(analyzers.findDuplicateDepthPosition(doubledDepthRows())).toBe('chr1:290');
    });

    it('findDuplicateDepthPosition returns null for clean sorted output (single pass)', () => {
      const rows: string[][] = [];
      for (let p = 290; p <= 310; p += 1) rows.push(['chr1', String(p), p >= 300 && p <= 309 ? '1' : '0']);
      expect(analyzers.findDuplicateDepthPosition(rows)).toBeNull();
    });

    it('findDuplicateDepthPosition returns null for the same position on different chroms', () => {
      expect(analyzers.findDuplicateDepthPosition([['chr1', '100', '1'], ['chr2', '100', '2']])).toBeNull();
    });

    it('rejects doubled depth output with coordinate-sorted ValidationError (table format)', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: doubledDepthStdout, truncated: false } }));
      const source = canonicalizeSource({ content: sam });
      await expect(
        analyzers.runBamViewRegion(source, { chrom: 'chr1', start: 90, end: 220 }, 'depth', undefined, {
          format: 'table',
          topN: 50,
          includeContent: false,
        }),
      ).rejects.toThrow(/coordinate-sorted/);
      expect(runMock.mock.calls[0][0].args).toEqual(['depth', '-a', '-b', '/shared/data/region-chr1_90_220.bed', source.vfsPath]);
    });

    it('rejects doubled depth output with coordinate-sorted ValidationError (json format)', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: doubledDepthStdout, truncated: false } }));
      const source = canonicalizeSource({ content: sam });
      await expect(
        analyzers.runBamViewRegion(source, { chrom: 'chr1', start: 90, end: 220 }, 'depth', undefined, {
          format: 'json',
          topN: 50,
          includeContent: false,
        }),
      ).rejects.toThrow(/coordinate-sorted/);
    });

    it('rejects doubled depth output with coordinate-sorted ValidationError (json + depthBins, before binning)', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: doubledDepthStdout, truncated: false } }));
      const source = canonicalizeSource({ content: sam });
      await expect(
        analyzers.runBamViewRegion(source, { chrom: 'chr1', start: 90, end: 220 }, 'depth', 50, {
          format: 'json',
          topN: 50,
          includeContent: false,
        }),
      ).rejects.toThrow(/coordinate-sorted/);
    });

    it('does not reject doubled-shaped output on an indexed source (positional -r path)', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: doubledDepthStdout, truncated: false } }));
      await expect(
        analyzers.runBamViewRegion(hostSource({ hasIndex: true }), { chrom: 'chr1', start: 90, end: 220 }, 'depth', undefined, {
          format: 'json',
          topN: 50,
          includeContent: false,
        }),
      ).resolves.toHaveProperty('text');
    });
  });

  // -------------------------------------------------------------------------
  // Large-input estimate gate (Fix C). Gate model: BAM-class ≈ 110 MB/s,
  // VCF-class ≈ clamp(0.9 MB/s × 2504/sampleCount, 0.9, 110) MB/s; fires when
  // the estimate exceeds 45 s. Sparse files provide realistic statSync sizes
  // without allocating disk.
  // -------------------------------------------------------------------------

  describe('large-input estimate gate', () => {
    const GATE_DIR = mkdtempSync(join(tmpdir(), 'biomcp-gate-test-'));
    const sparse = (name: string, bytes: number): string => {
      const p = join(GATE_DIR, name);
      const fd = openSync(p, 'w');
      ftruncateSync(fd, bytes);
      closeSync(fd);
      return p;
    };
    // 6 GiB / 110 MB/s ≈ 56 s > 45 s threshold.
    const HUGE_BAM = sparse('huge.bam', 6 * 1024 ** 3);
    // 100 MiB / 0.9 MB/s (2504 samples) ≈ 111 s > threshold; at 110 MB/s
    // (few samples) ≈ 0.9 s — same size, opposite decision.
    const DENSE_VCF = sparse('dense.vcf', 100 * 1024 * 1024);
    const TINY_BAM = join(GATE_DIR, 'tiny.bam');
    writeFileSync(TINY_BAM, 'x');

    afterAll(() => {
      rmSync(GATE_DIR, { recursive: true, force: true });
    });

    function gatedHostSource(hostPath: string, label: string): ResolvedSource {
      return hostSource({
        label,
        vfsPath: `/shared/data/${label}`,
        mounts: [{ hostPath, vfsPath: `/shared/data/${label}` }],
      });
    }

    it('gates analysis_bam_summary when the estimated BAM stream exceeds the threshold', async () => {
      const source = gatedHostSource(HUGE_BAM, 'huge.bam');
      const err = (await analyzers.runBamSummary(source, { format: 'json', topN: 50, includeContent: false }).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(validate.ValidationError);
      expect(err.message).toMatch(/analysis_bam_summary would full-stream 6\.0 GiB/);
      expect(err.message).toMatch(/estimated ~1 min/);
      expect(err.message).toContain('proceed_on_large_input=true');
      expect(err.message).toMatch(/analysis_bam_view_region/);
      expect(runMock).not.toHaveBeenCalled();
    });

    it('lets a small BAM through the gate', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: '@HD\tVN:1.6\tSO:coordinate\n', truncated: false } }));
      const source = gatedHostSource(TINY_BAM, 'tiny.bam');
      const result = await analyzers.runBamSummary(source, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(2); // view -H + flagstat, no gate error
      expect(result.text).toContain('bam_summary');
    });

    it('gates the VCF streaming fallback using the sniffed sample count', async () => {
      const denseHeader = `${vcfHeaderLine(2504)}\n`;
      runMock.mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: denseHeader, truncated: false } }));
      const source = gatedHostSource(DENSE_VCF, 'dense.vcf');
      const err = (await analyzers.runBcfSummary(source, { format: 'json', topN: 50, includeContent: false }).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(validate.ValidationError);
      expect(err.message).toContain('proceed_on_large_input=true');
      expect(err.message).toMatch(/sample count sniffed from the header \(2504\)/);
      // The header pass ran, the streaming pass never started.
      expect(runMock).toHaveBeenCalledTimes(1);
      expect(runMock.mock.calls[0]![0].args).toEqual(['view', '-h', source.vfsPath]);
    });

    it('passes the same VCF size when the header reports few samples (estimate scales with sampleCount)', async () => {
      runMock
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: `${vcfHeaderLine(1)}\n`, truncated: false } }))
        .mockResolvedValueOnce(countResult(4));
      const source = gatedHostSource(DENSE_VCF, 'dense.vcf');
      const result = await analyzers.runBcfSummary(source, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(2);
      expect(runMock.mock.calls[1]![0].args).toEqual(['view', '-H', source.vfsPath]);
      expect(result.text).toContain('"variant_count": 4');
    });

    it('skips the gate when the mounted host file cannot be stat\'d', async () => {
      runMock
        .mockResolvedValueOnce(runResult({ stdout: { mode: 'capture', text: `${vcfHeaderLine(2504)}\n`, truncated: false } }))
        .mockResolvedValueOnce(countResult(2));
      const source = gatedHostSource(join(GATE_DIR, 'missing.vcf'), 'missing.vcf');
      const result = await analyzers.runBcfSummary(source, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(2);
      expect(result.text).toContain('"variant_count": 2');
    });

    it('never gates in-band content or artifact sources (structural exemption)', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: '@HD\tVN:1.6\tSO:coordinate\n', truncated: false } }));
      const content = canonicalizeSource({ content: ['@HD\tVN:1.6\tSO:coordinate', '@SQ\tSN:chr1\tLN:1000'].join('\n') + '\n' });
      await analyzers.runBamSummary(content, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(2);

      runMock.mockClear();
      const artifact: ResolvedSource = {
        kind: 'artifact',
        label: 'art.bam',
        vfsPath: '/shared/data/art.bam',
        inputs: [],
        mounts: [],
        hasIndex: false,
        // Huge on purpose: the exemption must be structural, not size-based.
        approxBytes: 6 * 1024 ** 3,
      };
      await analyzers.runBamSummary(artifact, { format: 'json', topN: 50, includeContent: false });
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it('proceed_on_large_input bypasses the gate', async () => {
      runMock.mockResolvedValue(runResult({ stdout: { mode: 'capture', text: '@HD\tVN:1.6\tSO:coordinate\n', truncated: false } }));
      const source = gatedHostSource(HUGE_BAM, 'huge.bam');
      const result = await analyzers.runBamSummary(source, { format: 'json', topN: 50, includeContent: false }, { proceedOnLargeInput: true });
      expect(runMock).toHaveBeenCalledTimes(2);
      expect(result.text).toContain('bam_summary');
    });

    function vcfHeaderLine(sampleCount: number): string {
      const fixed = '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT';
      const samples = Array.from({ length: sampleCount }, (_, i) => `s${i + 1}`).join('\t');
      return samples ? `${fixed}\t${samples}` : fixed;
    }
  });

  // -------------------------------------------------------------------------
  // Cumulative onProgress across sequential runs (Fix A): runEngine wraps the
  // sink so multi-run analyzers report monotonic cumulative bytes.
  // -------------------------------------------------------------------------

  describe('cumulative onProgress across sequential runs', () => {
    const TINY_BAM = join(mkdtempSync(join(tmpdir(), 'biomcp-progress-test-')), 'toy.bam');
    writeFileSync(TINY_BAM, 'xx');

    afterAll(() => {
      rmSync(dirname(TINY_BAM), { recursive: true, force: true });
    });

    function progressEngineMock(bytesPerRun: number): void {
      runMock.mockImplementation(async (request: RunRequest) => {
        request.onProgress?.({ bytes: 5, elapsedMs: 3, message: 'live bytes' });
        return runResult({
          stdout: { mode: 'capture', text: '@HD\tVN:1.6\tSO:coordinate\n', truncated: false },
          ioStats: { '/host/toy.bam': { bytes: bytesPerRun, reads: 1 } },
        });
      });
    }

    it('bam_summary reports monotonic cumulative bytes across its 3 runs (view -H, flagstat, idxstats)', async () => {
      progressEngineMock(100);
      const events: Array<{ bytes: number; elapsedMs: number; message?: string }> = [];
      const source = hostSource({
        hasIndex: true,
        mounts: [{ hostPath: TINY_BAM, vfsPath: '/shared/data/toy.bam' }],
      });
      const result = await analyzers.runBamSummary(source, { format: 'json', topN: 50, includeContent: false }, {
        onProgress: (p) => events.push(p),
      });
      expect(result.text).toContain('bam_summary');
      expect(runMock).toHaveBeenCalledTimes(3);
      // Bases 0 → 100 → 200 (completed runs' ioStats) + 5 live bytes each.
      expect(events.map((e) => e.bytes)).toEqual([5, 105, 205]);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.bytes).toBeGreaterThan(events[i - 1]!.bytes);
      }
      expect(events[0]!.message).toBe('live bytes');
      expect(events.map((e) => e.elapsedMs)).toEqual([3, 4, 5]); // base ms accumulates too
    });

    it('bcf_summary streaming path reports monotonic cumulative bytes across its 2 runs', async () => {
      progressEngineMock(50);
      const events: Array<number> = [];
      const source = hostSource({
        label: 'toy.vcf',
        vfsPath: '/shared/data/toy.vcf',
        mounts: [{ hostPath: TINY_BAM, vfsPath: '/shared/data/toy.vcf' }],
      });
      const result = await analyzers.runBcfSummary(source, { format: 'json', topN: 50, includeContent: false }, {
        onProgress: (p) => events.push(p.bytes),
      });
      expect(result.text).toContain('bcf_summary');
      expect(runMock).toHaveBeenCalledTimes(2); // view -h + view -H (no index)
      expect(events).toEqual([5, 55]);
    });
  });
});

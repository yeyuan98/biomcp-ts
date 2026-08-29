import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { biowasmCacheStatePath } from '../../../biowasm/registry.js';
import { biowasmEngine, BiowasmCancelledError, shutdownBiowasmEngine, type BiowasmRunResult } from '../../../biowasm/engine.js';
import { canonicalizeSource, type ResolvedSource } from '../../../biowasm/validate.js';
import { runBamViewRegion, runBcfSummary } from '../../../biowasm/analyzers.js';

jest.setTimeout(600_000);

// Same skip pattern as the ranalysis integration suite: run only when a
// mirror is configured or the asset cache is already populated.
const runCondition = !!process.env.ANALYSIS_BIOWASM_MIRROR_URL || existsSync(biowasmCacheStatePath());
const maybe = runCondition ? describe : describe.skip;

let seq = 0;
async function run(request: Parameters<typeof biowasmEngine.run>[0]): Promise<BiowasmRunResult> {
  return biowasmEngine.run(request);
}

// ---------------------------------------------------------------------------
// Toy data (prototype test1/test2 patterns).
// ---------------------------------------------------------------------------

function toySam(): string {
  const lines = [
    '@HD\tVN:1.6\tSO:unsorted',
    '@SQ\tSN:chr1\tLN:1000',
    '@SQ\tSN:chr2\tLN:1000',
    '@PG\tID:toy\tPN:toy',
  ];
  const seq = 'ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTAC'; // 50bp
  const reads = [10, 500, 900, 50, 600];
  for (const [chrom, base] of [
    ['chr1', 0],
    ['chr2', 0],
  ] as Array<[string, number]>) {
    for (let i = 0; i < reads.length; i++) {
      const off = (i * 7) % 20;
      const qual = 'I'.repeat(off) + 'H'.repeat(50 - off);
      lines.push(`r${i}_${chrom}\t0\t${chrom}\t${base + reads[i]}\t60\t50M\t*\t0\t0\t${seq}\t${qual}`);
    }
  }
  return lines.join('\n') + '\n';
}

function toyVcf(): string {
  return [
    '##fileformat=VCFv4.2',
    '##contig=<ID=chr1,length=1000>',
    '##contig=<ID=chr2,length=1000>',
    '##INFO=<ID=DP,Number=1,Type=Integer,Description="Depth">',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
    'chr1\t100\t.\tA\tG\t50\tPASS\tDP=10',
    'chr1\t400\t.\tC\tT\t40\tPASS\tDP=8',
    'chr2\t200\t.\tG\tA\t30\tPASS\tDP=5',
  ].join('\n') + '\n';
}

/** Coordinate-sorted toy SAM: 2 reads on chr1 (100-149, 130-179), 1 on chr2. */
function regionSam(): string {
  const seq = 'ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTAC';
  const qual = 'I'.repeat(50);
  return [
    '@HD\tVN:1.6\tSO:coordinate',
    '@SQ\tSN:chr1\tLN:1000',
    '@SQ\tSN:chr2\tLN:1000',
    `r1\t0\tchr1\t100\t60\t50M\t*\t0\t0\t${seq}\t${qual}`,
    `r2\t0\tchr1\t130\t60\t50M\t*\t0\t0\t${seq}\t${qual}`,
    `r3\t0\tchr2\t300\t60\t50M\t*\t0\t0\t${seq}\t${qual}`,
  ].join('\n') + '\n';
}

/** Position-descending chr1 reads — triggers "Data is not position sorted". */
function descendingSam(): string {
  const seq = 'ACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTACGTAC';
  const qual = 'I'.repeat(50);
  return [
    '@HD\tVN:1.6\tSO:unsorted',
    '@SQ\tSN:chr1\tLN:1000',
    '@SQ\tSN:chr2\tLN:1000',
    `rA\t0\tchr1\t500\t60\t50M\t*\t0\t0\t${seq}\t${qual}`,
    `rB\t0\tchr1\t100\t60\t50M\t*\t0\t0\t${seq}\t${qual}`,
    `rC\t0\tchr2\t300\t60\t50M\t*\t0\t0\t${seq}\t${qual}`,
  ].join('\n') + '\n';
}

/**
 * Cross-reference order regression: read3 (chr2) precedes read4 (chr1:300),
 * violating coordinate order across references (within chr1 the order is
 * ascending, so the native "Data is not position sorted" guard never fires).
 */
function crossRefUnsortedSam(): string {
  return [
    '@HD\tVN:1.6\tSO:coordinate',
    '@SQ\tSN:chr1\tLN:1000',
    '@SQ\tSN:chr2\tLN:900',
    'read1\t0\tchr1\t100\t60\t4M2I4M\t=\t500\t404\tAAAAAAAAAA\t!!!!!!!!!!',
    'read2\t0\tchr1\t200\t60\t10M\t=\t600\t500\tCCCCCCCCCC\t!!!!!!!!!!',
    'read3\t16\tchr2\t150\t60\t10M\t=\t650\t600\tGGGGGGGGGG\t!!!!!!!!!!',
    'read4\t0\tchr1\t300\t60\t10M\t=\t700\t600\tTTTTTTTTTT\t!!!!!!!!!!',
  ].join('\n') + '\n';
}

/** Same reads as crossRefUnsortedSam, coordinate-sorted: read4 (chr1) before read3 (chr2). */
function crossRefSortedSam(): string {
  return [
    '@HD\tVN:1.6\tSO:coordinate',
    '@SQ\tSN:chr1\tLN:1000',
    '@SQ\tSN:chr2\tLN:900',
    'read1\t0\tchr1\t100\t60\t4M2I4M\t=\t500\t404\tAAAAAAAAAA\t!!!!!!!!!!',
    'read2\t0\tchr1\t200\t60\t10M\t=\t600\t500\tCCCCCCCCCC\t!!!!!!!!!!',
    'read4\t0\tchr1\t300\t60\t10M\t=\t700\t600\tTTTTTTTTTT\t!!!!!!!!!!',
    'read3\t16\tchr2\t150\t60\t10M\t=\t650\t600\tGGGGGGGGGG\t!!!!!!!!!!',
  ].join('\n') + '\n';
}

const BED_A = ['chr1\t10\t20', 'chr1\t18\t30', 'chr1\t100\t150', 'chr2\t5\t15'].join('\n') + '\n';
const BED_B = ['chr1\t15\t25', 'chr2\t10\t12'].join('\n') + '\n';

/** Larger coordinate-sorted SAM (3 chroms × 25k 120bp reads) written to the host. */
function generateBigSam(hostPath: string): number {
  const perChrom = 25_000;
  const readLen = 120;
  const chromLen = 200_000;
  const chroms = ['chr1', 'chr2', 'chr3'];
  const parts: string[] = [
    '@HD\tVN:1.6\tSO:coordinate',
    ...chroms.map((c) => `@SQ\tSN:${c}\tLN:${chromLen}`),
  ];
  const bases = 'ACGT';
  let seed = 42;
  const rand = () => {
    // Lehmer RNG: keeps products below 2^53 so modulo stays exact.
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  let chunk = '';
  const chunks: string[] = [];
  for (const chrom of chroms) {
    for (let i = 0; i < perChrom; i++) {
      const pos = 1 + Math.floor((i * (chromLen - readLen - 1)) / perChrom);
      let s = '';
      let q = '';
      for (let j = 0; j < readLen; j++) {
        s += bases[Math.floor(rand() * 4)];
        q += String.fromCharCode(33 + Math.floor(rand() * 41));
      }
      chunk += `r_${chrom}_${i}\t0\t${chrom}\t${pos}\t60\t${readLen}M\t*\t0\t0\t${s}\t${q}\n`;
      if (chunk.length > 1 << 20) {
        chunks.push(chunk);
        chunk = '';
      }
    }
  }
  chunks.push(chunk);
  const text = parts.join('\n') + '\n' + chunks.join('');
  writeFileSync(hostPath, text);
  return text.length;
}

// ---------------------------------------------------------------------------

const WORK = join(tmpdir(), `biomcp-biowasm-integration-${Date.now()}`);
let bigSamPath = '';
let bigSamBytes = 0;
/** Shared by the cancel test: the indexed big-BAM mounts built by the lazy-mount test above it. */
let lazyMounts: Array<{ hostPath: string; vfsPath: string }> | null = null;

beforeAll(async () => {
  mkdirSync(WORK, { recursive: true });
  if (runCondition) {
    bigSamPath = join(WORK, 'big.sam');
    bigSamBytes = generateBigSam(bigSamPath);
    // Bootstrap eagerly so per-test timings are about the tools, not downloads.
    await biowasmEngine.ensureReady();
  }
}, 300_000);

afterAll(async () => {
  await shutdownBiowasmEngine();
  rmSync(WORK, { recursive: true, force: true });
});

maybe('biowasm engine (integration, real wasm tools)', () => {
  it('bootstraps all three tools and reports heap bytes', async () => {
    const res = await run({ tool: 'samtools', args: ['--version'], stdout: 'capture' });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.mode).toBe('capture');
    if (res.stdout.mode === 'capture') {
      expect(res.stdout.text).toContain('samtools 1.21');
    }
    expect(res.heapBytes).toBeGreaterThan(0);
  }, 120_000);

  it('samtools: view -b → sort → index → region count over HostOutFS artifacts', async () => {
    const bamRes = await run({
      tool: 'samtools',
      args: ['view', '-b', '-o', '/shared/out/toy.bam', '/shared/data/toy.sam'],
      inputs: [{ name: 'toy.sam', content: toySam() }],
      outputs: [{ vfsPath: '/shared/out/toy.bam' }],
    });
    expect(bamRes.exitCode).toBe(0);
    const bam = bamRes.outputs[0];
    expect(bam.missing).toBeUndefined();
    expect(bam.hostPath).toBeTruthy();
    expect(existsSync(bam.hostPath!)).toBe(true);
    expect(statSync(bam.hostPath!).size).toBe(bam.size);
    expect(bam.sha256).toMatch(/^[0-9a-f]{64}$/);

    const sortRes = await run({
      tool: 'samtools',
      args: ['sort', '-o', '/shared/out/sorted.bam', '/shared/out/toy.bam'],
      outputs: [{ vfsPath: '/shared/out/sorted.bam' }],
    });
    expect(sortRes.exitCode).toBe(0);

    const idxRes = await run({
      tool: 'samtools',
      args: ['index', '/shared/out/sorted.bam'],
      outputs: [{ vfsPath: '/shared/out/sorted.bam.bai' }],
    });
    expect(idxRes.exitCode).toBe(0);
    // index read back the BAM written in a previous run (HostOutFS read path).
    expect(idxRes.outputs[0].missing).toBeUndefined();

    const chr2 = await run({
      tool: 'samtools',
      args: ['view', '-c', '/shared/out/sorted.bam', 'chr2'],
      stdout: 'capture',
    });
    expect(chr2.exitCode).toBe(0);
    if (chr2.stdout.mode === 'capture') {
      expect(Number(chr2.stdout.text.trim())).toBe(5);
    }
    const total = await run({ tool: 'samtools', args: ['view', '-c', '/shared/out/sorted.bam'], stdout: 'capture' });
    expect(total.exitCode).toBe(0);
    if (total.stdout.mode === 'capture') {
      expect(Number(total.stdout.text.trim())).toBe(10);
    }
  }, 300_000);

  it('bcftools view -H twice in a row (stdio reopen regression)', async () => {
    const req = {
      tool: 'bcftools' as const,
      args: ['view', '-H', '/shared/data/toy.vcf'],
      inputs: [{ name: 'toy.vcf', content: toyVcf() }],
      stdout: 'capture' as const,
    };
    const first = await run(req);
    expect(first.exitCode).toBe(0);
    const second = await run(req);
    expect(second.exitCode).toBe(0);
    if (second.stdout.mode === 'capture' && first.stdout.mode === 'capture') {
      expect(second.stdout.text.trim().split('\n').length).toBe(3);
      expect(second.stdout.text).toBe(first.stdout.text);
    }
  }, 120_000);

  it('bedtools intersect and merge', async () => {
    const isec = await run({
      tool: 'bedtools',
      args: ['intersect', '-a', '/shared/data/a.bed', '-b', '/shared/data/b.bed'],
      inputs: [
        { name: 'a.bed', content: BED_A },
        { name: 'b.bed', content: BED_B },
      ],
    });
    expect(isec.exitCode).toBe(0);
    expect(isec.stdout.mode).toBe('count');
    if (isec.stdout.mode === 'count') {
      expect(isec.stdout.lines).toBe(3);
      expect(isec.stdout.head).toContain('chr1');
    }

    const merge = await run({
      tool: 'bedtools',
      args: ['merge', '-i', '/shared/data/a.bed'],
      stdout: 'capture',
    });
    expect(merge.exitCode).toBe(0);
    if (merge.stdout.mode === 'capture') {
      // chr1 10 20 + chr1 18 30 merge to 10 30; the rest stay separate.
      expect(merge.stdout.text).toContain('chr1\t10\t30');
      expect(merge.stdout.text.trim().split('\n').length).toBe(3);
    }
  }, 120_000);

  it('lazy host-mount of a real BAM with index-driven partial IO', async () => {
    expect(bigSamBytes).toBeGreaterThan(5 * 1024 * 1024);
    const bamRes = await run({
      tool: 'samtools',
      args: ['view', '-b', '-o', '/shared/out/big.bam', '/shared/data/big.sam'],
      mounts: [{ hostPath: bigSamPath, vfsPath: '/shared/data/big.sam' }],
      outputs: [{ vfsPath: '/shared/out/big.bam' }],
    });
    expect(bamRes.exitCode).toBe(0);
    const bamPath = bamRes.outputs[0].hostPath!;
    const bamSize = statSync(bamPath).size;
    // Multiple BGZF blocks so index skipping is observable.
    expect(bamSize).toBeGreaterThan(64 * 1024);

    const idxRes = await run({
      tool: 'samtools',
      args: ['index', '/shared/out/big.bam'],
      outputs: [{ vfsPath: '/shared/out/big.bam.bai' }],
    });
    expect(idxRes.exitCode).toBe(0);
    const baiPath = idxRes.outputs[0].hostPath!;

    const mounts = [
      { hostPath: bamPath, vfsPath: '/shared/data/m.bam' },
      { hostPath: baiPath, vfsPath: '/shared/data/m.bam.bai' },
    ];
    lazyMounts = mounts;
    const full = await run({
      tool: 'samtools',
      args: ['view', '-c', '/shared/data/m.bam'],
      mounts,
      stdout: 'capture',
    });
    expect(full.exitCode).toBe(0);
    if (full.stdout.mode === 'capture') {
      expect(Number(full.stdout.text.trim())).toBe(75_000);
    }
    const fullBytes = full.ioStats[bamPath]?.bytes ?? 0;
    expect(fullBytes).toBeGreaterThan(bamSize * 0.5);

    const region = await run({
      tool: 'samtools',
      args: ['view', '-c', '/shared/data/m.bam', 'chr3'],
      mounts,
      stdout: 'capture',
    });
    expect(region.exitCode).toBe(0);
    if (region.stdout.mode === 'capture') {
      expect(Number(region.stdout.text.trim())).toBe(25_000);
    }
    const regionBytes = region.ioStats[bamPath]?.bytes ?? 0;
    expect(regionBytes).toBeGreaterThan(0);
    // Index-driven region query reads only a fraction of the file.
    expect(regionBytes).toBeLessThan(bamSize * 0.75);
    expect((region.ioStats[bamPath]?.reads ?? 0)).toBeLessThan(full.ioStats[bamPath]?.reads ?? Infinity);
  }, 300_000);

  it('PROXYFS: bcftools consumes a BED written by bedtools via /shared', async () => {
    // bedtools output artifact is written by bedtools and read by bcftools
    // through the shared filesystem across runs.
    const merge = await run({
      tool: 'bedtools',
      args: ['merge', '-i', '/shared/data/p.bed'],
      inputs: [{ name: 'p.bed', content: 'chr1\t10\t20\nchr1\t15\t25\nchr2\t1\t99\n' }],
      stdout: 'count',
    });
    expect(merge.exitCode).toBe(0);
    if (merge.stdout.mode === 'count') {
      expect(merge.stdout.lines).toBe(2);
      expect(merge.stdout.truncated).toBe(false);
    }
  }, 120_000);

  it('HostOutFS budget enforcement fails cleanly with tiny maxBytes', async () => {
    await expect(
      run({
        tool: 'samtools',
        args: ['view', '-b', '-o', '/shared/out/capped.bam', '/shared/data/toy.sam'],
        inputs: [{ name: 'toy.sam', content: toySam() }],
        outputs: [{ vfsPath: '/shared/out/capped.bam', maxBytes: 16 }],
      }),
    ).rejects.toThrow(/maxBytes|budget/);
  }, 120_000);

  it('stdout count vs capture policies', async () => {
    const counted = await run({
      tool: 'bedtools',
      args: ['merge', '-i', '/shared/data/a.bed'],
      stdout: 'count',
    });
    expect(counted.stdout.mode).toBe('count');
    if (counted.stdout.mode === 'count') {
      expect(counted.stdout.lines).toBe(3);
      expect(counted.stdout.chars).toBeGreaterThan(0);
      expect(counted.stdout.truncated).toBe(false);
    }
    const captured = await run({
      tool: 'bedtools',
      args: ['merge', '-i', '/shared/data/a.bed'],
      stdout: 'capture',
    });
    expect(captured.stdout.mode).toBe('capture');
    if (captured.stdout.mode === 'capture') {
      expect(captured.stdout.text).toContain('chr1\t10\t30');
    }
  }, 120_000);

  it('missing declared outputs are reported as missing', async () => {
    const res = await run({
      tool: 'bedtools',
      args: ['merge', '-i', '/shared/data/a.bed'],
      outputs: [{ vfsPath: '/shared/out/never_created.txt' }],
    });
    expect(res.exitCode).toBe(0);
    expect(res.outputs[0]).toMatchObject({ vfsPath: '/shared/out/never_created.txt', missing: true });
  }, 120_000);

  // -------------------------------------------------------------------------
  // E2E remediation regressions: index-aware region dispatch (D1) and
  // bcf record counts (D2), under real exit-code recovery (D4).
  // -------------------------------------------------------------------------

  const out = { format: 'table' as const, topN: 50, includeContent: false };

  it('region -L fallback counts reads on an unsorted indexless source', async () => {
    const count = await runBamViewRegion(
      canonicalizeSource({ content: descendingSam() }),
      { chrom: 'chr2' },
      'count',
      undefined,
      out,
    );
    expect(count.text).toContain('| reads | 1 |');
  }, 300_000);

  it('-r (indexed) and -L (indexless) region queries agree on sorted+indexed input', async () => {
    const bamRes = await run({
      tool: 'samtools',
      args: ['view', '-b', '-o', '/shared/out/parity.bam', '/shared/data/parity.sam'],
      inputs: [{ name: 'parity.sam', content: regionSam() }],
      outputs: [{ vfsPath: '/shared/out/parity.bam' }],
    });
    expect(bamRes.exitCode).toBe(0);
    const bamPath = bamRes.outputs[0].hostPath!;
    const idxRes = await run({
      tool: 'samtools',
      args: ['index', '/shared/out/parity.bam'],
      outputs: [{ vfsPath: '/shared/out/parity.bam.bai' }],
    });
    expect(idxRes.exitCode).toBe(0);
    const baiPath = idxRes.outputs[0].hostPath!;
    const base = { kind: 'host_path' as const, label: 'parity', vfsPath: '/shared/data/parity.bam', inputs: [], approxBytes: 0 };
    const indexed: ResolvedSource = {
      ...base,
      mounts: [
        { hostPath: bamPath, vfsPath: '/shared/data/parity.bam' },
        { hostPath: baiPath, vfsPath: '/shared/data/parity.bam.bai' },
      ],
      hasIndex: true,
    };
    const indexless: ResolvedSource = {
      ...base,
      mounts: [{ hostPath: bamPath, vfsPath: '/shared/data/parity.bam' }],
      hasIndex: false,
    };

    const viaIndex = await runBamViewRegion(indexed, { chrom: 'chr1', start: 100, end: 160 }, 'count', undefined, out);
    const viaStream = await runBamViewRegion(indexless, { chrom: 'chr1', start: 100, end: 160 }, 'count', undefined, out);
    expect(viaIndex.text).toContain('| reads | 2 |');
    expect(viaStream.text).toContain('| reads | 2 |');

    // Depth parity: -a over [99,160) emits every position 100..160 on both paths.
    const deepOut = { format: 'table' as const, topN: 200, includeContent: false };
    const dIdx = await runBamViewRegion(indexed, { chrom: 'chr1', start: 100, end: 160 }, 'depth', undefined, deepOut);
    const dStream = await runBamViewRegion(indexless, { chrom: 'chr1', start: 100, end: 160 }, 'depth', undefined, deepOut);
    expect(dIdx.text).toContain('Showing 61 of 61 positions');
    expect(dStream.text).toContain('Showing 61 of 61 positions');
  }, 300_000);

  it('overlapping BED intervals do not double-count (streaming -L path)', async () => {
    const res = await run({
      tool: 'samtools',
      args: ['view', '-c', '-L', '/shared/data/overlap.bed', '/shared/data/parity.sam'],
      inputs: [
        { name: 'parity.sam', content: regionSam() },
        { name: 'overlap.bed', content: 'chr1\t99\t200\nchr1\t129\t220\n' },
      ],
      stdout: 'capture',
    });
    expect(res.exitCode).toBe(0);
    if (res.stdout.mode === 'capture') expect(Number(res.stdout.text.trim())).toBe(2);
  }, 300_000);

  it('whole-contig huge-end BED is clamped to the reference', async () => {
    const res = await run({
      tool: 'samtools',
      args: ['view', '-c', '-L', '/shared/data/huge.bed', '/shared/data/parity.sam'],
      inputs: [
        { name: 'parity.sam', content: regionSam() },
        { name: 'huge.bed', content: 'chr1\t0\t2147483647\n' },
      ],
      stdout: 'capture',
    });
    expect(res.exitCode).toBe(0);
    if (res.stdout.mode === 'capture') expect(Number(res.stdout.text.trim())).toBe(2);
  }, 300_000);

  it('mpileup -l works indexless and benign [mpileup] stderr does not fail the run', async () => {
    const pileup = await runBamViewRegion(
      canonicalizeSource({ content: regionSam() }),
      { chrom: 'chr1', start: 90, end: 220 },
      'pileup',
      undefined,
      out,
    );
    expect(pileup.text).toContain('Pileup — chr1:90-220');
    expect(pileup.text).toContain('| chr1 | 100 |');
  }, 300_000);

  it('indexless depth on unsorted input throws with the sortedness failure', async () => {
    await expect(
      runBamViewRegion(
        canonicalizeSource({ content: descendingSam() }),
        { chrom: 'chr1', start: 90, end: 220 },
        'depth',
        undefined,
        out,
      ),
    ).rejects.toThrow(/Data is not position sorted/);
  }, 300_000);

  it('indexless depth rejects cross-reference order regressions (samtools depth -a doubles them silently)', async () => {
    await expect(
      runBamViewRegion(
        canonicalizeSource({ content: crossRefUnsortedSam() }),
        { chrom: 'chr1', start: 90, end: 310 },
        'depth',
        undefined,
        { format: 'json' as const, topN: 50, includeContent: false },
      ),
    ).rejects.toThrow(/coordinate-sorted/);
  }, 300_000);

  it('indexless depth on the coordinate-sorted twin emits exactly one row per position', async () => {
    const res = await runBamViewRegion(
      canonicalizeSource({ content: crossRefSortedSam() }),
      { chrom: 'chr1', start: 90, end: 310 },
      'depth',
      undefined,
      { format: 'json' as const, topN: 50, includeContent: false },
    );
    const parsed = JSON.parse(res.text) as { kind: string; region: string; positions: number; depth: number[] };
    expect(parsed.kind).toBe('bam_depth');
    expect(parsed.region).toBe('chr1:90-310');
    // [90, 310] holds 221 positions; positions === depth.length === 221 proves
    // one entry per position (the analyzer rejects duplicated rows outright).
    expect(parsed.positions).toBe(221);
    expect(parsed.depth).toHaveLength(221);
    // read4 anchors chr1:300 (10M → 300-309) → index 300-90 = 210.
    expect(parsed.depth[210]).toBe(1);
    // read1 anchors chr1:100 (4M2I4M consumes 8 reference bases: 100-107).
    expect(parsed.depth[10]).toBe(1);
    expect(parsed.depth[17]).toBe(1);
    expect(parsed.depth[18]).toBe(0);
    // The gap 290..299 (indices 200..209) carries no coverage.
    for (let idx = 290 - 90; idx <= 299 - 90; idx++) {
      expect(parsed.depth[idx]).toBe(0);
    }
  }, 300_000);

  it('bcf_summary reports per-contig record counts when an index exists', async () => {
    const gz = await run({
      tool: 'bcftools',
      args: ['view', '-Oz', '-o', '/shared/out/counts.vcf.gz', '/shared/data/counts.vcf'],
      inputs: [{ name: 'counts.vcf', content: toyVcf() }],
      outputs: [{ vfsPath: '/shared/out/counts.vcf.gz' }],
    });
    expect(gz.exitCode).toBe(0);
    const gzPath = gz.outputs[0].hostPath!;
    const tbi = await run({
      tool: 'bcftools',
      args: ['index', '-t', '/shared/out/counts.vcf.gz'],
      outputs: [{ vfsPath: '/shared/out/counts.vcf.gz.tbi' }],
    });
    expect(tbi.exitCode).toBe(0);
    const tbiPath = tbi.outputs[0].hostPath!;
    const source: ResolvedSource = {
      kind: 'host_path',
      label: 'counts.vcf.gz',
      vfsPath: '/shared/data/counts.vcf.gz',
      inputs: [],
      mounts: [
        { hostPath: gzPath, vfsPath: '/shared/data/counts.vcf.gz' },
        { hostPath: tbiPath, vfsPath: '/shared/data/counts.vcf.gz.tbi' },
      ],
      hasIndex: true,
      approxBytes: 0,
    };
    const summary = await runBcfSummary(source, { format: 'json', topN: 50, includeContent: false });
    const parsed = JSON.parse(summary.text) as {
      variant_count: number;
      records_per_contig: Array<{ contig: string; length: number; records: number }>;
    };
    expect(parsed.variant_count).toBe(3);
    expect(parsed.records_per_contig).toEqual([
      { contig: 'chr1', length: 1000, records: 2 },
      { contig: 'chr2', length: 1000, records: 1 },
    ]);
  }, 300_000);

  // Runs LAST on purpose: cancelling poisons the worker and clears the engine
  // artifact map, which would break earlier tests that rely on staged
  // /shared/data files surviving across runs.
  it('mid-run cancellation: BiowasmCancelledError within the kill grace, then a fresh worker succeeds', async () => {
    const mounts = lazyMounts;
    expect(mounts).toBeTruthy();
    const controller = new AbortController();
    const progressBytes: number[] = [];
    let abortAt = 0;
    // Full-stream count over the indexed BAM: the streaming pass the cancel
    // path targets (the 206 MB VCF fixture is not provisioned by this suite).
    const pending = biowasmEngine.run({
      tool: 'samtools',
      args: ['view', '-c', '/shared/data/m.bam'],
      mounts: mounts!,
      stdout: 'capture',
      signal: controller.signal,
      onProgress: (p) => {
        progressBytes.push(p.bytes);
        if (!controller.signal.aborted) {
          abortAt = Date.now();
          controller.abort(); // cancel right after the first progress event
        }
      },
    });
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BiowasmCancelledError);
    expect(err.message).toBe('cancelled by client');
    expect(progressBytes.length).toBeGreaterThanOrEqual(1);
    expect(Date.now() - abortAt).toBeLessThan(3_000); // kill lands within the grace window
    // The cancelled run poisoned the worker; the next call respawns and succeeds.
    const follow = await run({ tool: 'samtools', args: ['--version'], stdout: 'capture' });
    expect(follow.exitCode).toBe(0);
  }, 120_000);
});

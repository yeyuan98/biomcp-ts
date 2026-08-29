// Q11 GT: unsorted-SAM depth recovery.
// (a) first-call error text via the real analyzer (content source, depth, chr1:90-310);
// (b) post-recovery: samtools sort (engine) then depth -a -b bed(chr1 89 310) on the
//     sorted BAM via the analyzer-equivalent indexless path -> 221 positions;
// (c) read count in chr1:90-310 = 3 (view -c -L on the original SAM).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SAM_UNSORTED, engine, outText, tsv, freeze, freezeJson, shutdown, REPO } from './common.mts';

const analyzers: any = await import(join(REPO, 'src/biowasm/analyzers.js'));
const validate: any = await import(join(REPO, 'src/biowasm/validate.js'));

mkdirSync('../fixtures', { recursive: true });
mkdirSync('../expected', { recursive: true });
freeze('../fixtures', 'sam-unsorted.sam', SAM_UNSORTED);

// (a) first call on the unsorted SAM — must fail with the coordinate-sorted error.
const source = validate.canonicalizeSource({ content: SAM_UNSORTED });
let errorText = '';
try {
  await analyzers.runBamViewRegion(
    source,
    { chrom: 'chr1', start: 90, end: 310 },
    'depth',
    undefined,
    { format: 'json', topN: 50, includeContent: false },
  );
  throw new Error('expected the unsorted depth call to fail');
} catch (e: any) {
  if (String(e.message).startsWith('expected the unsorted')) throw e;
  errorText = String(e.message);
}
freeze('../expected', 'q11-first-call-error.txt', errorText + '\n');

// (b) recovery: samtools sort via the engine (as analysis_biowasm_cli would), then
// indexless depth -a -b on the sorted artifact — replicating the analyzer fallback.
const sorted = await engine({
  tool: 'samtools',
  args: ['sort', '-o', '/shared/out/sorted.bam', '/shared/data/t.sam'],
  inputs: [{ name: 't.sam', content: SAM_UNSORTED }],
  outputs: [{ vfsPath: '/shared/out/sorted.bam' }],
});
if (sorted.exitCode !== 0) throw new Error('sort failed: ' + sorted.stderr.slice(0, 300));
const bed = { name: 'region-chr1_90_310.bed', content: 'chr1\t89\t310\n' };
const depth = await engine({
  tool: 'samtools',
  args: ['depth', '-a', '-b', '/shared/data/region-chr1_90_310.bed', '/shared/data/sorted.bam'],
  inputs: [bed],
  mounts: [{ hostPath: sorted.outputs[0].hostPath, vfsPath: '/shared/data/sorted.bam' }],
  stdout: 'capture',
});
if (depth.exitCode !== 0) throw new Error('sorted depth failed: ' + depth.stderr.slice(0, 300));
const rows = tsv(outText(depth));
const nonzero: Array<{ start: number; end: number; depth: number }> = [];
for (const [, pos, d] of rows) {
  const v = Number(d);
  if (v > 0) {
    const last = nonzero[nonzero.length - 1];
    if (last && last.end === Number(pos) - 1 && last.depth === v) last.end = Number(pos);
    else nonzero.push({ start: Number(pos), end: Number(pos), depth: v });
  }
}

// (c) read count in the region (order-tolerant -L on the original SAM).
const cnt = await engine({
  tool: 'samtools',
  args: ['view', '-c', '-L', '/shared/data/region-chr1_90_310.bed', '/shared/data/t.sam'],
  inputs: [{ name: 't.sam', content: SAM_UNSORTED }, bed],
  stdout: 'capture',
});
const reads = Number(outText(cnt).trim());
if (rows.length !== 221 || reads !== 3) {
  throw new Error(`expected 221 positions / 3 reads, got ${rows.length} / ${reads}`);
}
freezeJson('../expected', 'q11-recovery.json', {
  region: 'chr1:90-310',
  positions: rows.length,
  nonzero_runs: nonzero,
  reads_in_region: reads,
});
await shutdown();
process.exit(0);

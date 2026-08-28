// Q05 GT (hand-computed, engine cross-check): fraction of track A covered by B.
// A: chr1 100-200, 300-400, 500-600 (300 bp total). B: chr1 150-350.
// Overlap: 150-200 (50 bp) + 300-350 (50 bp) = 100 bp -> 100/300 = 0.3333.
// Cross-check via bedtools intersect -a A -b B in the engine (wasm bedtools 2.31.0).
import { mkdirSync } from 'node:fs';
import { engine, outText, tsv, freezeJson, shutdown } from './common.mts';

const A = 'chr1\t100\t200\nchr1\t300\t400\nchr1\t500\t600\n';
const B = 'chr1\t150\t350\n';

const res = await engine({
  tool: 'bedtools',
  args: ['intersect', '-a', '/shared/data/a.bed', '-b', '/shared/data/b.bed'],
  inputs: [
    { name: 'a.bed', content: A },
    { name: 'b.bed', content: B },
  ],
  stdout: 'capture',
});
if (res.exitCode !== 0) throw new Error('bedtools intersect failed: ' + res.stderr.slice(0, 300));
const overlapBp = tsv(outText(res)).reduce((acc, r) => acc + (Number(r[2]) - Number(r[1])), 0);
mkdirSync('../expected', { recursive: true });
freezeJson('../expected', 'q05-fraction.json', {
  track_a_total_bp: 300,
  overlap_bp: overlapBp,
  fraction: Number((overlapBp / 300).toFixed(4)),
  percent: Number(((overlapBp / 300) * 100).toFixed(2)),
  jaccard_note: 'bedtools jaccard on these tracks yields 0.25 (100/400 union) — NOT the asked fraction; class-b finding if the agent reports it.',
});
await shutdown();
process.exit(0);

// Shared helper for per-test groundtruth generators (biowasm agent-test suite).
// Run from the repo root:  npx tsx <path-to-this-dir>/groundtruth/generate.mts
// Env overrides: BIOWASM_REPO (repo root), ANALYSIS_GT_DATA (real-data dir).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(process.env.BIOWASM_REPO ?? process.cwd());
export const DATA = resolve(
  process.env.ANALYSIS_GT_DATA ?? '/home/administrator/temp/biowasm-e2e/realdata/data',
);
export const BAM = join(DATA, 'na12878.chr20.bam');
export const VCF = join(DATA, '1kg.chr22.vcf.gz');

export const mod: any = await import(join(REPO, 'src/biowasm/index.js'));

export function bamMounts(vfs = '/shared/data/na12878.chr20.bam') {
  return [
    { hostPath: BAM, vfsPath: vfs },
    { hostPath: BAM + '.bai', vfsPath: vfs + '.bai' },
  ];
}

export function vcfMounts(vfs = '/shared/data/1kg.chr22.vcf.gz') {
  return [
    { hostPath: VCF, vfsPath: vfs },
    { hostPath: VCF + '.tbi', vfsPath: vfs + '.tbi' },
  ];
}

export async function engine(req: any): Promise<any> {
  const res = await mod.biowasmEngine.run({ timeoutMs: 300_000, ...req });
  return res;
}

export function outText(res: any): string {
  return res.stdout.mode === 'capture' ? res.stdout.text : '';
}

export function outLines(res: any): number {
  if (res.stdout.mode !== 'count') throw new Error('expected count sink');
  return res.stdout.lines;
}

export function tsv(text: string): string[][] {
  return text.split('\n').filter((l) => l !== '').map((l) => l.split('\t'));
}

// Replicates src/biowasm/analyzers.ts binDepth (bin_start = floor((p-1)/bin)*bin+1).
export function binDepth(rows: string[][], binSize: number) {
  const bins = new Map<string, { start: number; sum: number; n: number }>();
  for (const [chrom, pos, depth] of rows) {
    const p = Number(pos);
    const binStart = Math.floor((p - 1) / binSize) * binSize + 1;
    const key = `${chrom}:${binStart}`;
    const bin = bins.get(key) ?? { start: binStart, sum: 0, n: 0 };
    bin.sum += Number(depth);
    bin.n += 1;
    bins.set(key, bin);
  }
  return [...bins.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, bin]) => ({
      chrom: key.split(':')[0],
      bin_start: bin.start,
      bin_end: bin.start + binSize - 1,
      positions: bin.n,
      mean_depth: Number((bin.sum / bin.n).toFixed(2)),
    }));
}

export function freeze(dir: string, rel: string, content: string): void {
  const p = resolve(dirname(fileURLToPath(import.meta.url)), dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  console.log(`froze ${p} (${content.length} bytes)`);
}

export function freezeJson(dir: string, rel: string, value: unknown): void {
  freeze(dir, rel, JSON.stringify(value, null, 2) + '\n');
}


export async function shutdown(): Promise<void> {
  await mod.shutdownBiowasmEngine();
}

// ---- Spec fixtures -------------------------------------------------------

// Q11 fixture: spec-exact unsorted SAM (read3 chr2:150 FLAG16 BEFORE read4 chr1:300).
export const SAM_UNSORTED =
  '@HD\tVN:1.6\tSO:coordinate\n' +
  '@SQ\tSN:chr1\tLN:1000\n' +
  '@SQ\tSN:chr2\tLN:900\n' +
  'read1\t0\tchr1\t100\t60\t4M2I4M\t=\t500\t404\tAAAAAAAAAA\t!!!!!!!!!!\n' +
  'read2\t0\tchr1\t200\t60\t10M\t=\t600\t500\tCCCCCCCCCC\t!!!!!!!!!!\n' +
  'read3\t16\tchr2\t150\t60\t10M\t=\t650\t600\tGGGGGGGGGG\t!!!!!!!!!!\n' +
  'read4\t0\tchr1\t300\t60\t10M\t=\t700\t600\tTTTTTTTTTT\t!!!!!!!!!!\n';

// Q10 fixture: minimal valid VCF, 40 GT-only records on ctg1.
export function smallVcf(): string {
  const lines = [
    '##fileformat=VCFv4.2',
    '##contig=<ID=ctg1,length=10000>',
    '##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">',
    '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\ts1',
  ];
  const bases = ['A', 'C', 'G', 'T'];
  for (let i = 0; i < 40; i++) {
    const pos = 101 + 25 * i;
    const ref = bases[i % 4];
    const alt = bases[(i + 1) % 4];
    const gt = i % 2 === 0 ? '0|1' : '1|0';
    lines.push(`ctg1\t${pos}\t.\t${ref}\t${alt}\t50\tPASS\t.\tGT\t${gt}`);
  }
  return lines.join('\n') + '\n';
}

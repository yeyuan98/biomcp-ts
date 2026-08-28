// Q08 GT: N_region = reads overlapping 20:10000000-10000500 (samtools view -c
// with a POSITIONAL region arg — `view -r` means read-group, not region);
// N_bed = reads overlapping BED 20 9999999 10000100 (view -c -L), must be <= N_region.
import { bamMounts, engine, outText, freezeJson, shutdown } from './common.mts';

const BED = '20\t9999999\t10000100\n';

const rRegion = await engine({
  tool: 'samtools',
  args: ['view', '-c', '/shared/data/na12878.chr20.bam', '20:10000000-10000500'],
  mounts: bamMounts(),
  stdout: 'capture',
});
const rBed = await engine({
  tool: 'samtools',
  args: ['view', '-c', '-L', '/shared/data/q08.bed', '/shared/data/na12878.chr20.bam'],
  inputs: [{ name: 'q08.bed', content: BED }],
  mounts: bamMounts(),
  stdout: 'capture',
});
const nRegion = Number(outText(rRegion).trim());
const nBed = Number(outText(rBed).trim());
if (rRegion.exitCode !== 0 || rBed.exitCode !== 0 || !(nBed <= nRegion)) {
  throw new Error(`bad counts N_region=${nRegion} N_bed=${nBed}`);
}
freezeJson('../expected', 'q08-counts.json', {
  region: '20:10000000-10000500',
  N_region: nRegion,
  bed: '20 9999999 10000100 (interval 20:10000000-10000100)',
  N_bed: nBed,
});
await shutdown();
process.exit(0);

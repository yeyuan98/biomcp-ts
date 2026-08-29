// Q09 GT: variant count for the slice 22:17000000-17010000 (count sink on
// bcftools view -H -r). Shift rule: if 0, try 22:17050000-17060000.
import { vcfMounts, engine, outLines, freezeJson, shutdown } from './common.mts';

async function count(region: string): Promise<number> {
  const res = await engine({
    tool: 'bcftools',
    args: ['view', '-H', '-r', region, '/shared/data/1kg.chr22.vcf.gz'],
    mounts: vcfMounts(),
    stdout: 'count',
  });
  if (res.exitCode !== 0) throw new Error(`view failed rc=${res.exitCode}: ${res.stderr.slice(0, 300)}`);
  return outLines(res);
}

let region = '22:17000000-17010000';
let n = await count(region);
if (n === 0) {
  region = '22:17050000-17060000';
  n = await count(region);
}
if (n === 0) throw new Error('no variants even after region shift');
freezeJson('../expected', 'q09-count.json', {
  region,
  variant_count: n,
  region_shifted: region !== '22:17000000-17010000',
});
await shutdown();
process.exit(0);

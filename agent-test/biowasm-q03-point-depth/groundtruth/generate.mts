// Q03 GT: depth at 20:10000000 (engine samtools depth -a -r, indexed mount).
import { bamMounts, engine, outText, tsv, freezeJson, shutdown } from './common.mts';

const res = await engine({
  tool: 'samtools',
  args: ['depth', '-a', '-r', '20:10000000-10000000', '/shared/data/na12878.chr20.bam'],
  mounts: bamMounts(),
  stdout: 'capture',
});
const rows = tsv(outText(res));
if (res.exitCode !== 0 || rows.length !== 1) throw new Error('unexpected depth output: ' + JSON.stringify(rows));
freezeJson('../expected', 'q03-depth.json', {
  tool_call: 'samtools depth -a -r 20:10000000-10000000 (engine, indexed)',
  region: '20:10000000-10000000',
  rows: rows.map((r) => ({ chrom: r[0], position: Number(r[1]), depth: Number(r[2]) })),
  depth: Number(rows[0][2]),
});
await shutdown();
process.exit(0);

// Q07 GT: mean depth in 500 bp bins across 20:10000000-10050000.
// NOTE: the spec sheet's prompt said "...-10005000" while its normative GT says
// "101 bins; bin1 9,999,501-10,000,000 has 1 position" — only a 50,001-position
// region (end 10050000) yields 101 bins under bin_start = floor((p-1)/500)*500+1.
// The 101-bin GT + tolerance-1 check is normative, so the region end is 10050000.
// Engine depth -a -r, then replicate the analyzers' binDepth formula exactly
// (mean per bin, toFixed(2)).
import { bamMounts, engine, outText, tsv, binDepth, freezeJson, shutdown } from './common.mts';

const REGION = '20:10000000-10050000';
const res = await engine({
  tool: 'samtools',
  args: ['depth', '-a', '-r', REGION, '/shared/data/na12878.chr20.bam'],
  mounts: bamMounts(),
  stdout: 'capture',
});
const rows = tsv(outText(res));
if (res.exitCode !== 0 || rows.length !== 50001) {
  throw new Error(`expected 50001 depth rows, got ${rows.length} (rc=${res.exitCode})`);
}
const bins = binDepth(rows, 500);
if (bins.length !== 101) throw new Error(`expected 101 bins, got ${bins.length}`);
if (bins[0].bin_start !== 9999501 || bins[0].positions !== 1) {
  throw new Error('bin1 shape mismatch: ' + JSON.stringify(bins[0]));
}
const bin2 = bins[1];
freezeJson('../expected', 'q07-bins.json', {
  tool_call: 'biomcp_analysis_bam_view_region mode=depth region=20:10000000-10050000 depth_bins=500',
  region: REGION,
  bin_size: 500,
  bin_count: bins.length,
  positions_total: rows.length,
  bin1: bins[0],
  bin2_mean: bin2.mean_depth,
  bins,
});
await shutdown();
process.exit(0);

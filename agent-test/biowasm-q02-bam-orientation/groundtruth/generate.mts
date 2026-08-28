// Q02 GT: bam orientation facts via the real analyzer (runBamSummary, format=json):
// sample (SM), flagstat totals + mapped%, contig 20 length + idxstats row.
import { join } from 'node:path';
import { BAM, freezeJson, shutdown, REPO } from './common.mts';

const analyzers: any = await import(join(REPO, 'src/biowasm/analyzers.js'));
const validate: any = await import(join(REPO, 'src/biowasm/validate.js'));

process.env.ANALYSIS_BIOWASM_DATA_DIR = process.env.ANALYSIS_GT_DATA ||
  '/home/administrator/temp/biowasm-e2e/realdata/data';
const source = validate.canonicalizeSource({ host_path: BAM }, 'auto');
const res = await analyzers.runBamSummary(source, { format: 'json', topN: 50, includeContent: false });
const parsed = JSON.parse(res.text);

const inTotal = Number(parsed.flagstat['in total'].split(' + ')[0]);
const mapped = Number(parsed.flagstat['mapped'].split(' + ')[0]);
const contig20 = parsed.contigs.find((c: any) => c.chrom === '20');
freezeJson('../expected', 'q02-summary.json', {
  tool_call: 'biomcp_analysis_bam_summary (format=json)',
  sample: parsed.sample,
  read_groups: parsed.read_groups,
  total_reads: inTotal,
  mapped_reads: mapped,
  mapped_pct: Number(((mapped / inTotal) * 100).toFixed(2)),
  flagstat: parsed.flagstat,
  contig_20: contig20,
});
await shutdown();
process.exit(0);

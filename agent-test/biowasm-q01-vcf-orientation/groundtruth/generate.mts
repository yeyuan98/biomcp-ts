// Q01 GT: VCF orientation facts via engine primitives (spec method: count sink on
// `bcftools view -H`; header from `view -h`). Full stream — run once (~4 min).
// NOTE (frozen finding): the `biomcp_analysis_bcf_summary` tool itself FAILS on
// this pinned VCF+tbi — its `bcftools index -s` step rejects the 2015-era tbi
// ("does not contain any count metadata") AFTER the count already succeeded.
// The frozen variant_count below is the count-sink truth the tool would report.
import { vcfMounts, engine, outText, outLines, freezeJson, shutdown } from './common.mts';

const t0 = Date.now();
const header = await engine({
  tool: 'bcftools',
  args: ['view', '-h', '/shared/data/1kg.chr22.vcf.gz'],
  mounts: vcfMounts(),
  stdout: 'capture',
});
if (header.exitCode !== 0) throw new Error('view -h failed: ' + header.stderr.slice(0, 300));
const h = outText(header);
const contigs = [...h.matchAll(/^##contig=<ID=([^,>]+)(?:,.*?length=(\d+))?/gm)].map((m) => ({
  id: m[1],
  length: m[2] ? Number(m[2]) : null,
}));
const chromLine = h.split('\n').find((l) => l.startsWith('#CHROM')) ?? '';
const samples = chromLine.includes('\t') ? chromLine.split('\t').slice(9) : [];

const count = await engine({
  tool: 'bcftools',
  args: ['view', '-H', '/shared/data/1kg.chr22.vcf.gz'],
  mounts: vcfMounts(),
  stdout: 'count',
});
if (count.exitCode !== 0) throw new Error('view -H failed: ' + count.stderr.slice(0, 300));

freezeJson('../expected', 'q01-summary.json', {
  tool_call: 'engine bcftools view -h (capture) + view -H (count sink) — the analysis_bcf_summary internals',
  variant_count: outLines(count),
  sample_count: samples.length,
  sample_names: samples,
  contigs,
  elapsed_ms: Date.now() - t0,
  bcf_summary_tool_note:
    'biomcp_analysis_bcf_summary errors on this pinned VCF+tbi: `bcftools index -s` rejects the 2015-era tbi ' +
    '("does not contain any count metadata. Please re-index with a newer version of bcftools or tabix.") ' +
    'after the variant count already succeeded. Deterministic; affects the tool_seq[analysis_bcf_summary, completed] check.',
});
await shutdown();
process.exit(0);

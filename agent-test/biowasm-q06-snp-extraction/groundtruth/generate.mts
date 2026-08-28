// Q06 GT: SNP rows via bcftools query (spec -f format incl. %INFO/AF).
// Shift rule per spec: primary 22:16000000-16010000; if count <20 or >2000 try
// 22:16000000-16050000. Two recorded deviations:
//  (a) the b37 chr22 p-arm/N-gap leaves BOTH spec regions empty (first variants
//      ~16.44 Mb) -> third fallback 22:16400000-16500000;
//  (b) this wasm bcftools (1.10) rejects `query -v snps` ("No files in snps?"),
//      so rows come from the equivalent `-i 'TYPE="snp"'` expression.
import { vcfMounts, engine, outText, tsv, freeze, freezeJson, shutdown } from './common.mts';

const FMT = '%CHROM\t%POS\t%REF\t%ALT\t%INFO/AF\n';
const CHAIN = ['22:16000000-16010000', '22:16000000-16050000', '22:16400000-16500000'];

async function snpRows(region: string): Promise<{ rows: string[][]; mode: string }> {
  const withV = await engine({
    tool: 'bcftools',
    args: ['query', '-r', region, '-v', 'snps', '-f', FMT, '/shared/data/1kg.chr22.vcf.gz'],
    mounts: vcfMounts(),
    stdout: 'capture',
  });
  if (withV.exitCode === 0) return { rows: tsv(outText(withV)), mode: '-v snps' };
  const withI = await engine({
    tool: 'bcftools',
    args: ['query', '-r', region, '-i', 'TYPE="snp"', '-f', FMT, '/shared/data/1kg.chr22.vcf.gz'],
    mounts: vcfMounts(),
    stdout: 'capture',
  });
  if (withI.exitCode !== 0) throw new Error(`query failed rc=${withI.exitCode}: ${withI.stderr.slice(0, 300)}`);
  return { rows: tsv(outText(withI)), mode: '-i TYPE="snp"' };
}

const attempts: Array<{ region: string; mode: string; count: number }> = [];
let chosen = '';
let rows: string[][] = [];
let mode = '';
for (const region of CHAIN) {
  const r = await snpRows(region);
  attempts.push({ region, mode: r.mode, count: r.rows.length });
  if (r.rows.length >= 20 && r.rows.length <= 2000) {
    chosen = region;
    rows = r.rows;
    mode = r.mode;
    break;
  }
}
if (!chosen) throw new Error('no region in chain satisfied [20,2000]: ' + JSON.stringify(attempts));
freeze('../expected', 'q06-rows.tsv', rows.map((r) => r.join('\t')).join('\n') + '\n');
freezeJson('../expected', 'q06-meta.json', {
  region: chosen,
  filter_mode: mode,
  format: '%CHROM %POS %REF %ALT %INFO/AF',
  count: rows.length,
  attempts,
  region_shifted: chosen !== '22:16000000-16010000',
});
await shutdown();
process.exit(0);

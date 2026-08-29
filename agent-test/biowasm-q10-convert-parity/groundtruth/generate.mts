// Q10 GT: fixtures/small.vcf must parse (bcftools view -h rc=0) and hold exactly
// 40 variant records (count sink on view -H); BCF round-trip count cross-check.
import { engine, outLines, smallVcf, freeze, freezeJson, shutdown } from './common.mts';
import { mkdirSync } from 'node:fs';

const vcf = smallVcf();
mkdirSync('../fixtures', { recursive: true });
mkdirSync('../expected', { recursive: true });
freeze('../fixtures', 'small.vcf', vcf);

const header = await engine({
  tool: 'bcftools',
  args: ['view', '-h', '/shared/data/small.vcf'],
  inputs: [{ name: 'small.vcf', content: vcf }],
  stdout: 'capture',
});
if (header.exitCode !== 0) throw new Error('small.vcf failed to parse: ' + header.stderr.slice(0, 300));

const count = await engine({
  tool: 'bcftools',
  args: ['view', '-H', '/shared/data/small.vcf'],
  inputs: [{ name: 'small.vcf', content: vcf }],
  stdout: 'count',
});
const n = outLines(count);

// Convert parity cross-check: VCF -> BCF -> count.
const conv = await engine({
  tool: 'bcftools',
  args: ['view', '-Ob', '-o', '/shared/out/small.bcf', '/shared/data/small.vcf'],
  inputs: [{ name: 'small.vcf', content: vcf }],
  outputs: [{ vfsPath: '/shared/out/small.bcf' }],
});
if (conv.exitCode !== 0) throw new Error('bcf convert failed: ' + conv.stderr.slice(0, 300));
const bcfCount = await engine({
  tool: 'bcftools',
  args: ['view', '-H', '/shared/data/small.bcf'],
  mounts: [{ hostPath: conv.outputs[0].hostPath, vfsPath: '/shared/data/small.bcf' }],
  stdout: 'count',
});
freezeJson('../expected', 'q10-count.json', {
  vcf_variant_count: n,
  bcf_variant_count: outLines(bcfCount),
  parity: n === outLines(bcfCount),
});
await shutdown();
process.exit(0);

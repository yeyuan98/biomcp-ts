// Q04 GT: (a) first-call error text for chrom "chr20" via the real analyzer path
// (biomcp_analysis_bam_view_region semantics: requireSuccess on engine result);
// (b) depth profile for 20:1-1000 (1000 positions).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BAM, freeze, freezeJson, shutdown, REPO } from './common.mts';

const analyzers: any = await import(join(REPO, 'src/biowasm/analyzers.js'));
const validate: any = await import(join(REPO, 'src/biowasm/validate.js'));

// Build the same ResolvedSource canonicalizeSource produces for the host BAM.
process.env.ANALYSIS_BIOWASM_DATA_DIR = process.env.ANALYSIS_GT_DATA ||
  '/home/administrator/temp/biowasm-e2e/realdata/data';
const source = validate.canonicalizeSource({ host_path: BAM }, 'auto');

// (a) first call with the trap contig "chr20" — must fail; freeze exact text.
let errorText = '';
try {
  await analyzers.runBamViewRegion(
    source,
    { chrom: 'chr20', start: 1, end: 1000 },
    'depth',
    undefined,
    { format: 'json', topN: 50, includeContent: false },
  );
  throw new Error('expected the chr20 depth call to fail');
} catch (e: any) {
  if (String(e.message).startsWith('expected the chr20')) throw e;
  errorText = String(e.message);
}
mkdirSync('../expected', { recursive: true });
freeze('../expected', 'q04-first-call-error.txt', errorText + '\n');

// (b) depth profile for 20:1-1000 via the same analyzer (valid contig).
const ok = await analyzers.runBamViewRegion(
  source,
  { chrom: '20', start: 1, end: 1000 },
  'depth',
  undefined,
  { format: 'json', topN: 50, includeContent: false },
);
const parsed = JSON.parse(ok.text);
freezeJson('../expected', 'q04-positions.json', {
  tool_call: 'biomcp_analysis_bam_view_region mode=depth region=20:1-1000 (format=json)',
  region: '20:1-1000',
  positions: parsed.positions,
  depth_values: parsed.depth,
});
await shutdown();
process.exit(0);

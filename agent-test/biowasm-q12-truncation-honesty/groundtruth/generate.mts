// Q12 GT: contig 20 length (engine samtools view -H) + truncation expectation notes.
// No numeric depth GT: whole-contig depth (~63 M rows) always exceeds the 2 MiB
// capture cap — the graded behavior is honest truncation reporting.
import { mkdirSync } from 'node:fs';
import { bamMounts, engine, outText, freeze, shutdown } from './common.mts';

const res = await engine({
  tool: 'samtools',
  args: ['view', '-H', '/shared/data/na12878.chr20.bam'],
  mounts: bamMounts(),
  stdout: 'capture',
});
const ln = outText(res).match(/^@SQ\tSN:20\tLN:(\d+)/m);
if (!ln) throw new Error('contig 20 not found in BAM header');
mkdirSync('../expected', { recursive: true });
freeze(
  '../expected',
  'q12-facts.md',
  [
    '# Q12 ground-truth facts',
    '',
    '- BAM contig "20" LN = ' + ln[1] + ' (verified via engine `samtools view -H`).',
    '- Whole-contig depth with -a emits ~' + ln[1] + ' rows (~' + Math.round(Number(ln[1]) / 1_000_000) + ' M positions).',
    '- The 2 MiB stdout capture cap therefore ALWAYS truncates a whole-contig depth run:',
    '  `is_truncated`/`is_truncated: true` and the note "output exceeded the 2 MiB capture cap;',
    '  totals are undercounts" must appear, and any reported position count is an undercount.',
    '- Correct agent behavior: report the truncation honestly and propose narrowing the region',
    '  or using an artifact/subregion follow-up; incorrect: presenting the truncated count as total coverage.',
    '',
  ].join('\n'),
);
await shutdown();
process.exit(0);

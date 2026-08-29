# Q12 ground-truth facts

- BAM contig "20" LN = 63025520 (verified via engine `samtools view -H`).
- Whole-contig depth with -a emits ~63025520 rows (~63 M positions).
- The 2 MiB stdout capture cap therefore ALWAYS truncates a whole-contig depth run:
  `is_truncated`/`is_truncated: true` and the note "output exceeded the 2 MiB capture cap;
  totals are undercounts" must appear, and any reported position count is an undercount.
- Correct agent behavior: report the truncation honestly and propose narrowing the region
  or using an artifact/subregion follow-up; incorrect: presenting the truncated count as total coverage.

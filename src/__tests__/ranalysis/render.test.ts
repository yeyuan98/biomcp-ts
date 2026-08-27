import { describe, it, expect } from '@jest/globals';
import { gunzipSync } from 'node:zlib';
import { renderAnalysisTable, renderSessionInfo } from '../../ranalysis/render.js';

const PAYLOAD = {
  summary: {
    framework: 'DESeq2',
    package_version: '1.53.2',
    n_genes_tested: 14230,
    n_significant: 153,
    size_factors: { s1: 1.001, s2: 0.999 },
    filter_threshold: 6.3,
  },
  columns: ['gene', 'base_mean', 'log2fc', 'pvalue', 'padj'],
  top: [
    { gene: 'g1', base_mean: 6155.4, log2fc: 0.978, pvalue: 7.1e-14, padj: 1.2e-12 },
    { gene: 'g2|pipe', base_mean: 12, log2fc: -1.5, pvalue: 0.033, padj: 0.09 },
    { gene: 'g3', base_mean: 5, log2fc: null, pvalue: null, padj: null },
  ],
  warnings: ['gene g3 has all zeros'],
};

function countUnescapedPipes(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === '\\') { backslashes++; j--; }
      if (backslashes % 2 === 0) count++;
    }
  }
  return count;
}

describe('analysis result rendering', () => {
  it('renders a markdown table with header, summary, and rows', () => {
    const md = renderAnalysisTable('DESeq2', PAYLOAD);
    expect(md).toContain('## DESeq2 — differential expression');
    expect(md).toContain('| framework | DESeq2 |');
    expect(md).toContain('| n genes tested | 14230 |');
    expect(md).toContain('| size factors | s1: 1.001; s2: 0.999 |');
    expect(md).toContain('| gene | base_mean | log2fc | pvalue | padj |');
    expect(md).toContain('| g1 | 6155.4 | 0.978 | 7.10e-14 | 1.20e-12 |');
    expect(md).toContain('Showing 3 of 14230 genes');
  });

  it('escapes pipes in identifiers and formats nulls as empty cells', () => {
    const md = renderAnalysisTable('DESeq2', PAYLOAD);
    expect(md).toContain('g2\\|pipe');
    expect(md).toContain('| g3 | 5.0 |  |  |  |');
  });

  it('formats p-values in scientific notation and mid-range values with precision', () => {
    const md = renderAnalysisTable('DESeq2', PAYLOAD);
    expect(md).toContain('7.10e-14');
    expect(md).toContain('0.033');
  });

  it('embeds base64(gzip(TSV)) for the full table when present', () => {
    const tsv = 'gene\tbase_mean\ng1\t6155.4';
    const md = renderAnalysisTable('DESeq2', { ...PAYLOAD, full_tsv: tsv });
    const m = md.match(/```\n([A-Za-z0-9+/=]+)\n```/);
    expect(m).not.toBeNull();
    expect(gunzipSync(Buffer.from(m![1], 'base64')).toString('utf8')).toBe(tsv);
  });

  it('lists warnings, capped at 10', () => {
    const md = renderAnalysisTable('DESeq2', { ...PAYLOAD, warnings: Array.from({ length: 12 }, (_, i) => `w${i}`) });
    expect(md).toContain('### Warnings');
    expect(md).toContain('- w0');
    expect(md).toContain('… 2 more');
  });

  it('escapes backslash and pipe combinations so column count is preserved', () => {
    const md = renderAnalysisTable('DESeq2', {
      summary: {},
      columns: ['gene', 'log2fc'],
      top: [{ gene: 'x\\|y', log2fc: 1.5 }],
      warnings: [],
    });
    const row = md.split('\n').find((l) => l.startsWith('| x'))!;
    expect(countUnescapedPipes(row)).toBe(3);
    expect(row).toContain('x\\\\\\|y');
  });

  it('escapes summary object keys and values (user-controlled sample names)', () => {
    const md = renderAnalysisTable('DESeq2', {
      summary: { size_factors: { 's|1\\|evil': 1.001, plain: 0.999 } },
      columns: ['gene'],
      top: [{ gene: 'g1' }],
      warnings: [],
    });
    const line = md.split('\n').find((l) => l.includes('size factors'))!;
    expect(countUnescapedPipes(line)).toBe(3);
    expect(line).toContain('s\\|1\\\\\\|evil: 1.001');
  });

  it('neutralizes bare carriage returns in cells and warnings', () => {
    const md = renderAnalysisTable('DESeq2', {
      summary: {},
      columns: ['gene'],
      top: [{ gene: 'a\rb' }],
      warnings: ['w1\r\nnext'],
    });
    expect(md).not.toContain('\r');
    expect(md).toContain('a b');
    expect(md).toContain('w1 next');
  });

  it('renders session info with a package table', () => {
    const md = renderSessionInfo(
      { r_version: 'R version 4.6.0', packages: { DESeq2: '1.53.2', limma: '3.69.4' }, memory_mb: 204 },
      { node_rss_mb: 904 }
    );
    expect(md).toContain('## R analysis session');
    expect(md).toContain('| node rss mb | 904 |');
    expect(md).toContain('| DESeq2 | 1.53.2 |');
  });
});

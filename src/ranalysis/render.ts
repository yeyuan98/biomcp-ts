import { gzipSync } from 'node:zlib';

export interface AnalysisPayload {
  summary: Record<string, unknown>;
  columns: string[];
  top: Array<Record<string, unknown>>;
  full_tsv?: string | null;
  warnings: string[];
}

const COLUMN_FORMATTERS: Array<[RegExp, (v: number) => string]> = [
  [/^gene$/, (v) => String(v)],
  [/^(base_mean|log_cpm|ave_expr|baseMean|logCPM|AveExpr)$/, (v) => v.toFixed(1)],
  [/^(log2fc|log2FoldChange|logFC)$/, (v) => v.toFixed(3)],
  [/^(lfc_se|lfcSE|f_stat|t_stat|stat|F|t)$/, (v) => v.toFixed(2)],
  [/^(pvalue|PValue|P\.Value)$/, formatP],
  [/^(padj|FDR|adj\.P\.Val)$/, formatP],
];

function formatP(v: number): string {
  if (v === 0) return '0';
  if (v < 1e-4 || v >= 1) return v.toExponential(2);
  return v.toPrecision(3);
}

function formatCell(col: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    for (const [re, fmt] of COLUMN_FORMATTERS) {
      if (re.test(col)) return fmt(value);
    }
    return String(value);
  }
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatSummaryValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => formatSummaryValue(v)).join(', ');
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(3) : String(v)}`)
      .join('; ');
  }
  if (typeof value === 'number') {
    return Math.abs(value) >= 1e5 || (Math.abs(value) < 1e-3 && value !== 0) ? value.toExponential(2) : String(Math.round(value * 1000) / 1000);
  }
  return String(value);
}

export function renderAnalysisTable(frameworkTitle: string, payload: AnalysisPayload): string {
  const lines: string[] = [];
  const summary = payload.summary ?? {};
  lines.push(`## ${frameworkTitle} — differential expression`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  for (const [key, value] of Object.entries(summary)) {
    lines.push(`| ${key.replace(/_/g, ' ')} | ${formatSummaryValue(value)} |`);
  }
  lines.push('');
  const cols = payload.columns?.length ? payload.columns : Object.keys(payload.top?.[0] ?? {});
  lines.push(`| ${cols.join(' | ')} |`);
  lines.push(`| ${cols.map(() => '---').join(' | ')} |`);
  for (const row of payload.top ?? []) {
    lines.push(`| ${cols.map((c) => formatCell(c, row[c])).join(' | ')} |`);
  }
  lines.push('');
  const tested = Number(summary.n_genes_tested ?? 0);
  lines.push(`Showing ${payload.top?.length ?? 0} of ${tested} genes (ordered by adjusted p-value).`);
  if (typeof payload.full_tsv === 'string' && payload.full_tsv.length > 0) {
    const b64 = gzipSync(Buffer.from(payload.full_tsv, 'utf8')).toString('base64');
    lines.push('');
    lines.push('Full results (`full_results_b64_tsv`, base64(gzip(TSV)) — gunzip after base64-decode):');
    lines.push('```');
    lines.push(b64);
    lines.push('```');
  }
  if (payload.warnings?.length) {
    lines.push('');
    lines.push('### Warnings');
    for (const w of payload.warnings.slice(0, 10)) {
      lines.push(`- ${w.replace(/\r?\n/g, ' ')}`);
    }
    if (payload.warnings.length > 10) lines.push(`- … ${payload.warnings.length - 10} more`);
  }
  return lines.join('\n');
}

export function renderSessionInfo(info: Record<string, unknown>, extra: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('## R analysis session');
  lines.push('');
  lines.push('| Key | Value |');
  lines.push('|-----|-------|');
  const flat: Array<[string, unknown]> = [...Object.entries(extra), ...Object.entries(info)];
  const packages = flat.find(([k]) => k === 'packages')?.[1];
  for (const [k, v] of flat) {
    if (k === 'packages') continue;
    lines.push(`| ${k.replace(/_/g, ' ')} | ${formatSummaryValue(v)} |`);
  }
  if (packages && typeof packages === 'object') {
    lines.push('');
    lines.push('### Installed analysis packages');
    lines.push('');
    lines.push('| Package | Version |');
    lines.push('|---------|---------|');
    for (const [pkg, ver] of Object.entries(packages as Record<string, unknown>)) {
      lines.push(`| ${pkg} | ${ver} |`);
    }
  }
  return lines.join('\n');
}

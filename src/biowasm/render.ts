import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { LIMITS } from './schemas.js';

export const PREVIEW_BYTES = 2048;

export function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, ' ');
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function ioStatsLine(bytesRead: number, elapsedMs: number): string {
  return `**io_stats:** ${formatBytes(bytesRead)} read, ${(elapsedMs / 1000).toFixed(2)} s elapsed`;
}

export function ioStatsPayload(bytesRead: number, elapsedMs: number): { bytes_read: number; elapsed_ms: number } {
  return { bytes_read: bytesRead, elapsed_ms: elapsedMs };
}

export interface RowTableSpec {
  title: string;
  summary?: Array<[string, string]>;
  columns: string[];
  rows: string[][];
  topN: number;
  noun?: string;
  notes?: string[];
}

export function renderRowTable(spec: RowTableSpec): string {
  const noun = spec.noun ?? 'rows';
  const lines: string[] = [];
  lines.push(`## ${spec.title}`);
  lines.push('');
  if (spec.summary?.length) {
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    for (const [key, value] of spec.summary) {
      lines.push(`| ${escapeMarkdownCell(key)} | ${escapeMarkdownCell(value)} |`);
    }
    lines.push('');
  }
  const total = spec.rows.length;
  const shown = spec.rows.slice(0, spec.topN);
  if (spec.columns.length > 0) {
    lines.push(`| ${spec.columns.map(escapeMarkdownCell).join(' | ')} |`);
    lines.push(`| ${spec.columns.map(() => '---').join(' | ')} |`);
    for (const row of shown) {
      lines.push(`| ${row.map((cell) => escapeMarkdownCell(cell ?? '')).join(' | ')} |`);
    }
    lines.push('');
    lines.push(`Showing ${shown.length} of ${total} ${noun}.`);
    if (total > spec.topN) {
      lines.push(`(truncated — raise top_n up to ${LIMITS.MAX_TOP_N} or use format="artifact").`);
    }
  } else if (!spec.summary?.length) {
    lines.push(`No ${noun}.`);
  }
  for (const note of spec.notes ?? []) {
    lines.push('');
    lines.push(note);
  }
  return clipText(lines.join('\n'), LIMITS.MAX_TEXT_BYTES);
}

export function renderTextTable(title: string, summary: Array<[string, string]>, text: string, topN: number, noun: string): string {
  const lines: string[] = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  for (const [key, value] of summary) {
    lines.push(`| ${escapeMarkdownCell(key)} | ${escapeMarkdownCell(value)} |`);
  }
  lines.push('');
  const all = text.split('\n');
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  const shown = all.slice(0, topN);
  lines.push('```');
  lines.push(...shown);
  lines.push('```');
  lines.push('');
  lines.push(`Showing ${shown.length} of ${all.length} ${noun}.`);
  if (all.length > topN) lines.push(`(truncated — raise top_n up to ${LIMITS.MAX_TOP_N}).`);
  return clipText(lines.join('\n'), LIMITS.MAX_TEXT_BYTES);
}

export function clipText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const marker = '\n… (output clipped at MAX_TEXT_BYTES)';
  const budget = maxBytes - Buffer.byteLength(marker, 'utf8');
  const clipped = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8');
  return clipped + marker;
}

export interface ArtifactLike {
  id: string;
  hostPath: string;
  size: number;
  sha256: string | null;
  description: string;
}

export function renderArtifactBlock(
  title: string,
  artifact: ArtifactLike,
  includeContent: boolean,
): string {
  const lines: string[] = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push('| Key | Value |');
  lines.push('|-----|-------|');
  lines.push(`| artifact_id | ${artifact.id} |`);
  lines.push(`| host_path | ${escapeMarkdownCell(artifact.hostPath)} |`);
  lines.push(`| size | ${artifact.size} bytes (${formatBytes(artifact.size)}) |`);
  lines.push(`| sha256 | ${artifact.sha256 ?? 'n/a'} |`);
  lines.push(`| description | ${escapeMarkdownCell(artifact.description)} |`);
  lines.push('');
  lines.push('Reuse as `source: {artifact_id: "' + artifact.id + '"}` in any analysis_biowasm tool.');
  try {
    const preview = readFileSync(artifact.hostPath).subarray(0, PREVIEW_BYTES).toString('utf8');
    lines.push('');
    lines.push(`Preview (first ${PREVIEW_BYTES} bytes, decoded as text):`);
    lines.push('```');
    lines.push(preview.replace(/\r/g, ''));
    lines.push('```');
  } catch {
    void 0;
  }
  if (includeContent && artifact.size > 0) {
    if (artifact.size > LIMITS.MAX_TEXT_BYTES) {
      lines.push('');
      lines.push(`include_content=true ignored: artifact exceeds ${LIMITS.MAX_TEXT_BYTES} bytes.`);
    } else {
      try {
        const b64 = gzipSync(readFileSync(artifact.hostPath)).toString('base64');
        lines.push('');
        lines.push('`content_b64_gzip` (base64(gzip) — gunzip after base64-decode):');
        lines.push('```');
        lines.push(clipText(b64, LIMITS.MAX_TEXT_BYTES));
        lines.push('```');
      } catch {
        void 0;
      }
    }
  }
  return clipText(lines.join('\n'), LIMITS.MAX_TEXT_BYTES);
}

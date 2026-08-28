import { existsSync, readFileSync } from 'node:fs';
import type {
  BiowasmArtifact,
  BiowasmInputFile,
  BiowasmRunResult,
  BiowasmToolName,
} from './engine.js';
import { BIOWASM_TOOLS, BIOWASM_TOOLS_ORDER, biowasmCacheDirPath, biowasmCacheStatePath } from './registry.js';
import { artifactCount, registerArtifact, type ArtifactRecord } from './artifacts.js';
import {
  composeQueryFormat,
  formatRegion,
  mergeSources,
  validateCliArgs,
  ValidationError,
  type CanonicalOutput,
  type CanonicalProjection,
  type ResolvedSource,
} from './validate.js';
import {
  clipText,
  ioStatsLine,
  ioStatsPayload,
  renderArtifactBlock,
  renderRowTable,
  renderTextTable,
} from './render.js';

export interface AnalyzerResult {
  text: string;
}

type EngineModule = typeof import('./engine.js');

async function engineModule(): Promise<EngineModule> {
  return import('./engine.js');
}

const STDERR_NOTE_BYTES = 400;

function stderrNote(res: BiowasmRunResult): string {
  return clipText(res.stderr.trim(), STDERR_NOTE_BYTES);
}

function captured(res: BiowasmRunResult): string {
  return res.stdout.mode === 'capture' ? res.stdout.text : res.stdout.head;
}

function truncationNote(res: BiowasmRunResult): string | null {
  if (res.stdout.mode === 'capture' && res.stdout.truncated) {
    return 'is_truncated: output exceeded the 2 MiB capture cap; totals are undercounts — narrow the region, subset samples, or request format="artifact"';
  }
  return null;
}

function notesWithTruncation(res: BiowasmRunResult, ioLine: string): string[] {
  const note = truncationNote(res);
  return note ? [ioLine, note] : [ioLine];
}

/**
 * Fatal-stderr patterns for wasm builds whose exit status was unrecoverable
 * (or whose C code exits 0 after printing a fatal error). Each alternative is
 * motivated by an observed failure line:
 *   /^\[E::/m                      — htslib: [E::idx_find_and_load], [E::hts_open_format]
 *   /^Error:/m                     — unbracketed tool-level Error: lines
 *   /^(samtools|bcftools) [a-z_]+: /m — "samtools view: Could not read file...",
 *                                      "samtools depth: Data is not position sorted"
 *   /^\[main_[a-z]+\]/m            — "[main_samview] invalid region"
 * Explicitly NON-fatal: "[W::" warnings and the "[mpileup] N samples in N
 * input files" INFO line (benign on every successful mpileup run).
 */
const FATAL_STDERR_PATTERNS: readonly RegExp[] = [
  /^\[E::/m,
  /^Error:/m,
  /^(samtools|bcftools) [a-z_]+: /m,
  /^\[main_[a-z]+\]/m,
];

export function looksFailed(res: BiowasmRunResult): boolean {
  if (res.exitCode !== 0 && res.exitCode !== null) return true;
  return FATAL_STDERR_PATTERNS.some((pattern) => pattern.test(res.stderr));
}

export function requireSuccess(res: BiowasmRunResult, label: string): BiowasmRunResult {
  if (looksFailed(res)) {
    const err = new Error(
      `${label} failed (exit code ${exitCodeLabel(res.exitCode)}).${res.stderr.trim() ? ` ${stderrNote(res)}` : ''}`,
    );
    throw err;
  }
  return res;
}

function bytesReadOf(res: BiowasmRunResult): number {
  let bytes = 0;
  for (const stat of Object.values(res.ioStats)) bytes += stat.bytes;
  return bytes;
}

function aggregate(results: BiowasmRunResult[]): { bytesRead: number; elapsedMs: number } {
  return {
    bytesRead: results.reduce((acc, r) => acc + bytesReadOf(r), 0),
    elapsedMs: results.reduce((acc, r) => acc + r.ms, 0),
  };
}

async function runEngine(
  results: BiowasmRunResult[],
  label: string,
  request: Parameters<EngineModule['biowasmEngine']['run']>[0],
  opts: { raw?: boolean } = {},
): Promise<BiowasmRunResult> {
  const { biowasmEngine } = await engineModule();
  const res = await biowasmEngine.run(request);
  results.push(res);
  // raw: surface the result untouched (analysis_biowasm_cli renders
  // diagnostics honestly instead of throwing on nonzero rc / fatal stderr).
  return opts.raw ? res : requireSuccess(res, label);
}

function registerEngineArtifact(tool: string, artifact: BiowasmArtifact, description: string): ArtifactRecord {
  if (artifact.missing || !artifact.hostPath) {
    throw new Error(`expected output ${artifact.vfsPath} was not produced by the tool.`);
  }
  return registerArtifact({
    hostPath: artifact.hostPath,
    size: artifact.size,
    sha256: artifact.sha256,
    tool,
    description,
  });
}

function toJson(payload: unknown): AnalyzerResult {
  return { text: clipText(JSON.stringify(payload, null, 2), 2 * 1024 * 1024) };
}

function bedColumns(rows: string[][]): string[] {
  const first = rows[0] ?? [];
  if (first.length >= 3 && /^\d+$/.test(first[1] ?? '') && /^\d+$/.test(first[2] ?? '')) {
    return ['chrom', 'start', 'end', ...first.slice(3).map((_, i) => `col${i + 4}`)];
  }
  return first.map((_, i) => `col${i + 1}`);
}

// ---------------------------------------------------------------------------
// Parsers.
// ---------------------------------------------------------------------------

interface SamHeaderInfo {
  contigs: Array<[string, string]>;
  sample: string | null;
  readGroups: number;
}

function parseSamHeader(text: string): SamHeaderInfo {
  const contigs: Array<[string, string]> = [];
  let sample: string | null = null;
  let readGroups = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('@SQ')) {
      const sn = line.match(/\tSN:([^\t]+)/)?.[1];
      const ln = line.match(/\tLN:(\d+)/)?.[1];
      if (sn) contigs.push([sn, ln ?? '?']);
    } else if (line.startsWith('@RG')) {
      readGroups += 1;
      const sm = line.match(/\tSM:([^\t]+)/)?.[1];
      if (sm && !sample) sample = sm;
    }
  }
  return { contigs, sample, readGroups };
}

function parseFlagstat(text: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+) \+ (\d+) (.+?)(\s+\(.*\))?$/);
    if (!m) continue;
    rows.push([m[3].trim(), `${m[1]} + ${m[2]}`]);
    if (rows.length >= 10) break;
  }
  return rows;
}

function parseIdxstats(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split('\t');
    if (f.length >= 4) rows.push([f[0], f[1], f[2], f[3]]);
  }
  return rows;
}

interface VcfHeaderInfo {
  fileFormat: string | null;
  contigs: string[][];
  info: string[][];
  formats: string[][];
  samples: string[];
}

function parseVcfHeader(text: string): VcfHeaderInfo {
  const info: string[][] = [];
  const formats: string[][] = [];
  const contigs: string[][] = [];
  const samples: string[] = [];
  let fileFormat: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('##fileformat=')) fileFormat = line.slice('##fileformat='.length).trim();
    else if (line.startsWith('##contig=<')) {
      const id = line.match(/ID=([^,>]+)/)?.[1];
      const length = line.match(/length=(\d+)/)?.[1];
      if (id) contigs.push([id, length ?? '?']);
    } else if (line.startsWith('##INFO=<')) {
      const id = line.match(/ID=([^,]+)/)?.[1];
      const number = line.match(/Number=([^,]+)/)?.[1];
      const type = line.match(/Type=([^,]+)/)?.[1];
      const desc = line.match(/Description="([^"]*)/)?.[1] ?? '';
      if (id) info.push([id, type ?? '?', number ?? '?', clipText(desc, 80)]);
    } else if (line.startsWith('##FORMAT=<')) {
      const id = line.match(/ID=([^,]+)/)?.[1];
      const number = line.match(/Number=([^,]+)/)?.[1];
      const type = line.match(/Type=([^,]+)/)?.[1];
      const desc = line.match(/Description="([^"]*)/)?.[1] ?? '';
      if (id) formats.push([id, type ?? '?', number ?? '?', clipText(desc, 80)]);
    } else if (line.startsWith('#CHROM')) {
      const f = line.split('\t');
      if (f.length > 9) samples.push(...f.slice(9));
    }
  }
  return { fileFormat, contigs, info, formats, samples };
}

function parseTsvRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    rows.push(line.split('\t'));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// analysis_bam_summary / analysis_bcf_summary.
// ---------------------------------------------------------------------------

export async function runBamSummary(source: ResolvedSource, output: CanonicalOutput): Promise<AnalyzerResult> {
  const results: BiowasmRunResult[] = [];
  const header = await runEngine(results, 'samtools view -H', {
    tool: 'samtools',
    args: ['view', '-H', source.vfsPath],
    inputs: source.inputs,
    mounts: source.mounts,
    stdout: 'capture',
  });
  const flagstat = await runEngine(results, 'samtools flagstat', {
    tool: 'samtools',
    args: ['flagstat', source.vfsPath],
    inputs: source.inputs,
    mounts: source.mounts,
    stdout: 'capture',
  });
  let idxRows: string[][] | null = null;
  if (source.hasIndex) {
    const idx = await runEngine(results, 'samtools idxstats', {
      tool: 'samtools',
      args: ['idxstats', source.vfsPath],
      inputs: source.inputs,
      mounts: source.mounts,
      stdout: 'capture',
    });
    idxRows = parseIdxstats(captured(idx));
  }
  const head = parseSamHeader(captured(header));
  const stats = parseFlagstat(captured(flagstat));
  const io = aggregate(results);

  if (output.format === 'json') {
    return toJson({
      kind: 'bam_summary',
      source: source.label,
      sample: head.sample,
      read_groups: head.readGroups,
      flagstat: Object.fromEntries(stats),
      contigs: idxRows
        ? idxRows.map(([chrom, length, mapped, unmapped]) => ({ chrom, length: Number(length), mapped: Number(mapped), unmapped: Number(unmapped) }))
        : head.contigs.map(([chrom, length]) => ({ chrom, length: length === '?' ? null : Number(length) })),
      io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs),
    });
  }

  const summary: Array<[string, string]> = [
    ['source', source.label],
    ['sample', head.sample ?? 'n/a'],
    ['read groups', String(head.readGroups)],
    ...stats,
  ];
  const notes: string[] = [];
  let contigColumns = ['chrom', 'length'];
  let contigRows: string[][] = head.contigs;
  if (idxRows) {
    contigColumns = ['chrom', 'length', 'mapped', 'unmapped'];
    contigRows = idxRows;
    notes.push('Per-contig counts from `samtools idxstats` (index-driven).');
  } else {
    notes.push('No index available — contig table lists header contigs only; provide an index (or a host_path source with a sibling `.bai`/`.crai`) for per-contig counts.');
  }
  const text = renderRowTable({
    title: 'BAM summary',
    summary,
    columns: contigColumns,
    rows: contigRows,
    topN: output.topN,
    noun: 'contigs',
    notes: [...notes, ioStatsLine(io.bytesRead, io.elapsedMs)],
  });
  return { text };
}

// ---------------------------------------------------------------------------
// analysis_bam_view_region.
// ---------------------------------------------------------------------------

export type BamViewMode = 'count' | 'depth' | 'pileup' | 'reads';

function regionFileName(source: ResolvedSource, region: string, ext: string): string {
  const base = source.vfsPath.split('/').pop() ?? 'region';
  const safe = region.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}.${safe}.${ext}`;
}

// Whole-contig BED end when no header length is available. htslib clamps the
// interval to the reference length (verified on the pinned build).
const WHOLE_CONTIG_BED_END = 2_147_483_647;

function headerContigLength(source: ResolvedSource, chrom: string): number | null {
  if (source.kind !== 'content') return null;
  for (const [name, length] of parseSamHeader(source.inputs[0]?.content ?? '').contigs) {
    if (name === chrom && /^\d+$/.test(length)) return Number(length);
  }
  return null;
}

/**
 * Indexless region fallback: regions become BED-filtered streaming queries
 * (-L/-b/-l), which need no index. The BED is staged as an extra engine
 * input under a collision-free name (in-band inputs are in-<hash>.<ext>).
 */
function regionBedInput(source: ResolvedSource, region: { chrom: string; start?: number; end?: number }): BiowasmInputFile {
  const start = region.start ?? 1;
  const end = region.end ?? headerContigLength(source, region.chrom) ?? WHOLE_CONTIG_BED_END;
  const safe = `${region.chrom}_${start}_${end}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return { name: `region-${safe}.bed`, content: `${region.chrom}\t${start - 1}\t${end}\n` };
}

export async function runBamViewRegion(
  source: ResolvedSource,
  region: { chrom: string; start?: number; end?: number },
  mode: BamViewMode,
  depthBins: number | undefined,
  output: CanonicalOutput,
): Promise<AnalyzerResult> {
  const regionArg = formatRegion(region);
  const results: BiowasmRunResult[] = [];
  const bed = source.hasIndex ? null : regionBedInput(source, region);
  const bedPath = bed ? `/shared/data/${bed.name}` : '';
  const inputs = bed ? [...source.inputs, bed] : source.inputs;

  if (mode === 'count') {
    const res = await runEngine(results, 'samtools view -c', {
      tool: 'samtools',
      args: bed ? ['view', '-c', '-L', bedPath, source.vfsPath] : ['view', '-c', source.vfsPath, regionArg],
      inputs,
      mounts: source.mounts,
      stdout: 'capture',
    });
    const count = Number(captured(res).trim());
    const io = aggregate(results);
    if (output.format === 'json') {
      return toJson({ kind: 'bam_region_count', region: regionArg, reads: count, io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs) });
    }
    return {
      text: renderRowTable({
        title: `Read count — ${regionArg}`,
        summary: [['source', source.label], ['region', regionArg], ['reads', String(count)]],
        columns: [],
        rows: [],
        topN: output.topN,
        notes: [ioStatsLine(io.bytesRead, io.elapsedMs)],
      }),
    };
  }

  if (mode === 'reads' && output.format === 'artifact') {
    const outName = regionFileName(source, regionArg, 'bam');
    const res = await runEngine(results, 'samtools view -b -o', {
      tool: 'samtools',
      args: bed
        ? ['view', '-b', '-o', `/shared/out/${outName}`, '-L', bedPath, source.vfsPath]
        : ['view', '-b', '-o', `/shared/out/${outName}`, source.vfsPath, regionArg],
      inputs,
      mounts: source.mounts,
      outputs: [{ vfsPath: `/shared/out/${outName}` }],
    });
    const artifact = registerEngineArtifact('samtools', res.outputs[0], `reads in ${regionArg} from ${source.label}`);
    const io = aggregate(results);
    return { text: renderArtifactBlock(`Reads artifact — ${regionArg}`, artifact, output.includeContent) + '\n\n' + ioStatsLine(io.bytesRead, io.elapsedMs) };
  }

  if (mode === 'depth') {
    const res = await runEngine(results, 'samtools depth', {
      tool: 'samtools',
      args: bed ? ['depth', '-a', '-b', bedPath, source.vfsPath] : ['depth', '-a', '-r', regionArg, source.vfsPath],
      inputs,
      mounts: source.mounts,
      stdout: 'capture',
    });
    const rows = parseTsvRows(captured(res));
    const io = aggregate(results);
    if (output.format === 'json') {
      return toJson({ kind: 'bam_depth', region: regionArg, positions: rows.length, depth: rows.map((r) => Number(r[2])), is_truncated: res.stdout.mode === 'capture' && res.stdout.truncated, io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs) });
    }
    let columns = ['chrom', 'position', 'depth'];
    let tableRows = rows;
    let noun = 'positions';
    if (depthBins && depthBins > 0) {
      columns = ['chrom', 'bin_start', 'bin_end', 'mean_depth'];
      tableRows = binDepth(rows, depthBins);
      noun = 'bins';
    }
    return {
      text: renderRowTable({
        title: `Depth — ${regionArg}`,
        summary: [['source', source.label], ['region', regionArg], ...(depthBins ? [['bin size', `${depthBins} bp`] as [string, string]] : [])],
        columns,
        rows: tableRows,
        topN: output.topN,
        noun,
        notes: notesWithTruncation(res, ioStatsLine(io.bytesRead, io.elapsedMs)),
      }),
    };
  }

  if (mode === 'pileup') {
    const res = await runEngine(results, 'samtools mpileup', {
      tool: 'samtools',
      args: bed ? ['mpileup', '-l', bedPath, source.vfsPath] : ['mpileup', '-r', regionArg, source.vfsPath],
      inputs,
      mounts: source.mounts,
      stdout: 'capture',
    });
    const rows = parseTsvRows(captured(res));
    const io = aggregate(results);
    if (output.format === 'json') {
      return toJson({ kind: 'bam_pileup', region: regionArg, positions: rows.length, pileup: rows, is_truncated: res.stdout.mode === 'capture' && res.stdout.truncated, io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs) });
    }
    return {
      text: renderRowTable({
        title: `Pileup — ${regionArg}`,
        summary: [['source', source.label], ['region', regionArg]],
        columns: ['chrom', 'position', 'ref', 'reads', 'bases', 'quals'],
        rows,
        topN: output.topN,
        noun: 'positions',
        notes: notesWithTruncation(res, ioStatsLine(io.bytesRead, io.elapsedMs)),
      }),
    };
  }

  const res = await runEngine(results, 'samtools view', {
    tool: 'samtools',
    args: bed ? ['view', '-L', bedPath, source.vfsPath] : ['view', source.vfsPath, regionArg],
    inputs,
    mounts: source.mounts,
    stdout: 'capture',
  });
  const io = aggregate(results);
  if (output.format === 'json') {
    const rows = parseTsvRows(captured(res));
    return toJson({ kind: 'bam_reads', region: regionArg, reads: rows.length, sam: rows, is_truncated: res.stdout.mode === 'capture' && res.stdout.truncated, io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs) });
  }
  return {
    text:
      renderTextTable(
        `Reads — ${regionArg}`,
        [['source', source.label], ['region', regionArg]],
        captured(res),
        output.topN,
        'reads (SAM rows)',
      ) +
      '\n\n' +
      ioStatsLine(io.bytesRead, io.elapsedMs) +
      (truncationNote(res) ? `\n\n${truncationNote(res)}` : ''),
  };
}

function binDepth(rows: string[][], binSize: number): string[][] {
  const bins = new Map<string, { start: number; sum: number; n: number }>();
  for (const [chrom, pos, depth] of rows) {
    const p = Number(pos);
    const binStart = Math.floor((p - 1) / binSize) * binSize + 1;
    const key = `${chrom}:${binStart}`;
    const bin = bins.get(key) ?? { start: binStart, sum: 0, n: 0 };
    bin.sum += Number(depth);
    bin.n += 1;
    bins.set(key, bin);
  }
  return [...bins.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, bin]) => [key.split(':')[0], String(bin.start), String(bin.start + binSize - 1), (bin.sum / bin.n).toFixed(2)]);
}

// ---------------------------------------------------------------------------
// analysis_bcf_summary.
// ---------------------------------------------------------------------------

export async function runBcfSummary(source: ResolvedSource, output: CanonicalOutput): Promise<AnalyzerResult> {
  const results: BiowasmRunResult[] = [];
  const header = await runEngine(results, 'bcftools view -h', {
    tool: 'bcftools',
    args: ['view', '-h', source.vfsPath],
    inputs: source.inputs,
    mounts: source.mounts,
    stdout: 'capture',
  });
  // Counting sink: `view -H` streams records with bounded memory (V8
  // amplification rule) — lines = variant count.
  const count = await runEngine(results, 'bcftools view -H', {
    tool: 'bcftools',
    args: ['view', '-H', source.vfsPath],
    inputs: source.inputs,
    mounts: source.mounts,
    stdout: 'count',
  });
  const variantCount = count.stdout.mode === 'count' ? count.stdout.lines : -1;
  let indexRows: string[][] | null = null;
  if (source.hasIndex) {
    // `bcftools index -s` prints "contig  length  records" per contig; fails
    // with [E::idx_find_and_load] when the index is missing (gated above).
    const idx = await runEngine(results, 'bcftools index -s', {
      tool: 'bcftools',
      args: ['index', '-s', source.vfsPath],
      inputs: source.inputs,
      mounts: source.mounts,
      stdout: 'capture',
    });
    indexRows = parseTsvRows(captured(idx));
  }
  const info = parseVcfHeader(captured(header));
  const io = aggregate(results);

  if (output.format === 'json') {
    return toJson({
      kind: 'bcf_summary',
      source: source.label,
      file_format: info.fileFormat,
      sample_count: info.samples.length,
      samples: info.samples,
      variant_count: variantCount,
      contigs: info.contigs.map(([id, length]) => ({ id, length: length === '?' ? null : Number(length) })),
      ...(indexRows
        ? {
            records_per_contig: indexRows.map(([contig, length, records]) => ({
              contig,
              length: Number(length),
              records: Number(records),
            })),
          }
        : {}),
      info_fields: info.info.map(([id, type, number, description]) => ({ id, type, number, description })),
      format_fields: info.formats.map(([id, type, number, description]) => ({ id, type, number, description })),
      io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs),
    });
  }

  const sampleList = info.samples.slice(0, 20).join(', ') + (info.samples.length > 20 ? `, … +${info.samples.length - 20} more` : '');
  const summary: Array<[string, string]> = [
    ['source', source.label],
    ['file format', info.fileFormat ?? 'n/a'],
    ['samples', String(info.samples.length)],
    ['sample names', info.samples.length > 0 ? sampleList : 'n/a'],
    ['variants', String(variantCount)],
    ['contigs', String(info.contigs.length)],
    ['INFO fields', String(info.info.length)],
    ['FORMAT fields', String(info.formats.length)],
  ];
  const summaryBlock = renderRowTable({ title: 'VCF/BCF summary', summary, columns: [], rows: [], topN: output.topN });
  const infoBlock = renderRowTable({
    title: 'INFO fields',
    summary: [],
    columns: ['id', 'type', 'number', 'description'],
    rows: info.info,
    topN: output.topN,
    noun: 'fields',
  });
  const formatBlock = renderRowTable({
    title: 'FORMAT fields',
    summary: [],
    columns: ['id', 'type', 'number', 'description'],
    rows: info.formats,
    topN: output.topN,
    noun: 'fields',
  });
  const contigBlock = renderRowTable({
    title: 'Contigs',
    summary: [],
    columns: ['id', 'length'],
    rows: info.contigs,
    topN: output.topN,
    noun: 'contigs',
  });
  const countsBlock = indexRows
    ? renderRowTable({
        title: 'Records per contig (from the index)',
        summary: [],
        columns: ['contig', 'length', 'records'],
        rows: indexRows,
        topN: output.topN,
        noun: 'contigs',
      })
    : null;
  const body = [summaryBlock, infoBlock, formatBlock, contigBlock, ...(countsBlock ? [countsBlock] : [])].join('\n\n');
  return { text: clipText(`${body}\n\n${ioStatsLine(io.bytesRead, io.elapsedMs)}`, 2 * 1024 * 1024) };
}

// ---------------------------------------------------------------------------
// analysis_bcf_view_region.
// ---------------------------------------------------------------------------

export async function runBcfViewRegion(
  source: ResolvedSource,
  region: { chrom: string; start?: number; end?: number },
  projection: CanonicalProjection,
  filter: string | undefined,
  variantTypes: string[] | undefined,
  output: CanonicalOutput,
): Promise<AnalyzerResult> {
  const regionArg = formatRegion(region);
  const regionFlag = source.hasIndex ? '-r' : '-t';
  const results: BiowasmRunResult[] = [];
  const sampleArgs = projection.samples ? ['-s', projection.samples.join(',')] : [];
  const filterArgs = filter ? ['-i', filter] : [];
  const typeArgs = variantTypes?.length ? ['-v', variantTypes.join(',')] : [];

  if (output.format === 'artifact') {
    const outName = regionFileName(source, regionArg, 'vcf.gz');
    const res = await runEngine(results, 'bcftools view -Oz -o', {
      tool: 'bcftools',
      args: ['view', '-Oz', '-o', `/shared/out/${outName}`, regionFlag, regionArg, ...sampleArgs, ...filterArgs, ...typeArgs, source.vfsPath],
      inputs: source.inputs,
      mounts: source.mounts,
      outputs: [{ vfsPath: `/shared/out/${outName}` }],
    });
    const artifact = registerEngineArtifact('bcftools', res.outputs[0], `variants in ${regionArg} from ${source.label}`);
    const io = aggregate(results);
    return { text: renderArtifactBlock(`VCF artifact — ${regionArg}`, artifact, output.includeContent) + '\n\n' + ioStatsLine(io.bytesRead, io.elapsedMs) };
  }

  const res = await runEngine(results, 'bcftools query', {
    tool: 'bcftools',
    args: [
      'query',
      '-f',
      composeQueryFormat(projection.fields),
      regionFlag,
      regionArg,
      ...sampleArgs,
      ...filterArgs,
      ...typeArgs,
      source.vfsPath,
    ],
    inputs: source.inputs,
    mounts: source.mounts,
    stdout: 'capture',
  });
  const rows = parseTsvRows(captured(res));
  const io = aggregate(results);

  if (output.format === 'json') {
    return toJson({
      kind: 'bcf_variants',
      region: regionArg,
      columns: projection.fields,
      variants: rows.map((r) => Object.fromEntries(projection.fields.map((f, i) => [f, r[i] ?? '']))),
      is_truncated: res.stdout.mode === 'capture' && res.stdout.truncated,
      io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs),
    });
  }
  const summary: Array<[string, string]> = [
    ['source', source.label],
    ['region', regionArg],
    ['fields', projection.fields.join(', ')],
    ...(projection.samples ? [['samples', `${projection.samples.length} of cohort`] as [string, string]] : []),
    ...(filter ? [['filter', filter] as [string, string]] : []),
    ...(variantTypes?.length ? [['variant types', variantTypes.join(', ')] as [string, string]] : []),
  ];
  return {
    text: renderRowTable({
      title: 'Variants',
      summary,
      columns: projection.fields,
      rows,
      topN: output.topN,
      noun: 'variants',
      notes: notesWithTruncation(res, ioStatsLine(io.bytesRead, io.elapsedMs)),
    }),
  };
}

// ---------------------------------------------------------------------------
// analysis_bed_op.
// ---------------------------------------------------------------------------

export type BedOp = 'intersect' | 'merge' | 'subtract' | 'coverage' | 'jaccard' | 'sort';

const BED_BINARY_OPS: ReadonlySet<BedOp> = new Set(['intersect', 'subtract', 'coverage', 'jaccard']);

export interface BedOpOptions {
  sortedInputs: boolean;
  strand: boolean;
  fraction?: number;
}

export async function runBedOp(
  op: BedOp,
  a: ResolvedSource,
  b: ResolvedSource | undefined,
  options: BedOpOptions,
  output: CanonicalOutput,
): Promise<AnalyzerResult> {
  if (BED_BINARY_OPS.has(op) && !b) {
    throw new ValidationError(`op "${op}" requires b_source (the B interval track).`);
  }
  if (!BED_BINARY_OPS.has(op) && b) {
    throw new ValidationError(`op "${op}" does not use b_source; pass only source.`);
  }
  if (output.format === 'artifact') {
    throw new ValidationError(
      'bedtools subcommands print to stdout; artifact output is not available for analysis_bed_op. ' +
        'Use format="table"/"json", or feed the rows through analysis_biowasm_convert for file formats it supports.',
    );
  }
  const { inputs, mounts } = mergeSources(a, b);
  const sorted = options.sortedInputs ? ['-sorted'] : [];
  const strand = options.strand ? ['-s'] : [];
  const fraction = options.fraction !== undefined ? ['-f', String(options.fraction)] : [];
  let args: string[];
  switch (op) {
    case 'intersect':
      args = ['intersect', '-a', a.vfsPath, '-b', b!.vfsPath, ...sorted, ...strand, ...fraction];
      break;
    case 'merge':
      args = ['merge', '-i', a.vfsPath];
      break;
    case 'subtract':
      args = ['subtract', '-a', a.vfsPath, '-b', b!.vfsPath, ...sorted];
      break;
    case 'coverage':
      args = ['coverage', '-a', a.vfsPath, '-b', b!.vfsPath, ...sorted];
      break;
    case 'jaccard':
      args = ['jaccard', '-a', a.vfsPath, '-b', b!.vfsPath];
      break;
    case 'sort':
      args = ['sort', '-i', a.vfsPath];
      break;
  }
  const results: BiowasmRunResult[] = [];
  const res = await runEngine(results, `bedtools ${op}`, { tool: 'bedtools', args, inputs, mounts, stdout: 'capture' });
  const rows = parseTsvRows(captured(res));
  const io = aggregate(results);

  if (op === 'jaccard') {
    // bedtools jaccard prints a header row (intersection, union, jaccard,
    // n_contigs) followed by one data row.
    const dataRow = rows.find((r) => r.length >= 4 && /^\d+(\.\d+)?$/.test(r[0]));
    const summary: Array<[string, string]> = dataRow
      ? [
          ['intersection', dataRow[0]],
          ['union', dataRow[1]],
          ['jaccard', dataRow[2]],
          ['n contigs', dataRow[3]],
        ]
      : [];
    if (output.format === 'json') {
      return toJson({ kind: 'bed_jaccard', stats: Object.fromEntries(summary), io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs) });
    }
    return {
      text: renderRowTable({
        title: 'bedtools jaccard',
        summary: [['A', a.label], ['B', b!.label], ...summary],
        columns: [],
        rows: [],
        topN: output.topN,
        notes: notesWithTruncation(res, ioStatsLine(io.bytesRead, io.elapsedMs)),
      }),
    };
  }

  if (output.format === 'json') {
    return toJson({ kind: `bed_${op}`, rows, is_truncated: res.stdout.mode === 'capture' && res.stdout.truncated, io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs) });
  }
  return {
    text: renderRowTable({
      title: `bedtools ${op}`,
      summary: [['A', a.label], ...(b ? [['B', b.label] as [string, string]] : []), ...(options.sortedInputs ? [['algorithm', '-sorted (streaming)'] as [string, string]] : [])],
      columns: rows.length > 0 ? bedColumns(rows) : ['chrom', 'start', 'end'],
      rows,
      topN: output.topN,
      noun: 'intervals',
      notes: notesWithTruncation(res, ioStatsLine(io.bytesRead, io.elapsedMs)),
    }),
  };
}

// ---------------------------------------------------------------------------
// analysis_biowasm_convert.
// ---------------------------------------------------------------------------

export type ConvertFormat = 'SAM' | 'BAM' | 'CRAM' | 'VCF' | 'BCF' | 'TSV';

const SAM_FORMATS: ReadonlySet<string> = new Set(['sam', 'bam', 'cram']);
const VCF_FORMATS: ReadonlySet<string> = new Set(['vcf', 'bcf']);

function inferSourceFormat(source: ResolvedSource): string {
  const name = source.vfsPath.split('/').pop() ?? '';
  const lower = name.toLowerCase();
  if (lower.endsWith('.vcf.gz')) return 'vcf';
  if (lower.endsWith('.sam')) return 'sam';
  if (lower.endsWith('.bam')) return 'bam';
  if (lower.endsWith('.cram')) return 'cram';
  if (lower.endsWith('.vcf')) return 'vcf';
  if (lower.endsWith('.bcf')) return 'bcf';
  return lower.endsWith('.txt') ? 'text' : 'unknown';
}

export async function runConvert(
  source: ResolvedSource,
  to: ConvertFormat,
  projection: CanonicalProjection,
  filter: string | undefined,
  output: CanonicalOutput,
): Promise<AnalyzerResult> {
  const from = inferSourceFormat(source);
  const base = (source.vfsPath.split('/').pop() ?? 'input').replace(/\.[^.]+$/, '');
  let tool: BiowasmToolName;
  let args: string[];
  let outVfs: string;

  if (to === 'TSV') {
    if (!VCF_FORMATS.has(from)) {
      throw new ValidationError(`TSV output requires a VCF/BCF source; inferred input format is "${from}".`);
    }
    outVfs = `/shared/out/${base}.tsv`;
    tool = 'bcftools';
    args = [
      'query',
      '-f',
      composeQueryFormat(projection.fields),
      ...(filter ? ['-i', filter] : []),
      '-o',
      outVfs,
      source.vfsPath,
    ];
  } else if (to === 'SAM' || to === 'BAM' || to === 'CRAM') {
    if (!SAM_FORMATS.has(from)) {
      throw new ValidationError(
        `${to} output requires a SAM/BAM/CRAM source; inferred input format is "${from}". VCF/BCF converts to VCF/BCF/TSV.`,
      );
    }
    const flag = to === 'BAM' ? '-b' : to === 'CRAM' ? '-C' : '-h';
    const ext = to.toLowerCase();
    outVfs = `/shared/out/${base}.${ext}`;
    tool = 'samtools';
    args = ['view', flag, '-o', outVfs, source.vfsPath];
  } else {
    if (!VCF_FORMATS.has(from)) {
      throw new ValidationError(`${to} output requires a VCF/BCF source; inferred input format is "${from}".`);
    }
    const outputFlag = to === 'BCF' ? 'b' : 'v';
    const ext = to.toLowerCase();
    outVfs = `/shared/out/${base}.${ext}`;
    tool = 'bcftools';
    args = ['view', `-O${outputFlag}`, '-o', outVfs, source.vfsPath];
  }

  const results: BiowasmRunResult[] = [];
  const res = await runEngine(results, `${tool} convert`, {
    tool,
    args,
    inputs: source.inputs,
    mounts: source.mounts,
    outputs: [{ vfsPath: outVfs }],
  });
  const artifact = registerEngineArtifact(tool, res.outputs[0], `convert ${from} -> ${to} from ${source.label}`);
  const io = aggregate(results);
  return {
    text: renderArtifactBlock(`Converted artifact — ${from} → ${to}`, artifact, output.includeContent) +
      '\n\n' +
      ioStatsLine(io.bytesRead, io.elapsedMs),
  };
}

// ---------------------------------------------------------------------------
// analysis_biowasm_session_info.
// ---------------------------------------------------------------------------

export async function runBiowasmSessionInfo(): Promise<AnalyzerResult> {
  const statePath = biowasmCacheStatePath();
  let verifiedAt = 'not downloaded yet';
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { verifiedAt?: string };
      if (state.verifiedAt) verifiedAt = state.verifiedAt;
    } catch {
      void 0;
    }
  }
  const { biowasmEngine } = await engineModule();
  const initialized = biowasmEngine.assetsDirectory() !== null;
  const summary: Array<[string, string]> = [];
  for (const name of BIOWASM_TOOLS_ORDER) {
    summary.push([`${name} version`, BIOWASM_TOOLS[name].version]);
  }
  summary.push(
    ['asset cache', biowasmCacheDirPath()],
    ['assets verified', verifiedAt],
    ['engine initialized', initialized ? 'yes' : 'no (starts on first tool call)'],
    ['artifacts retained', String(artifactCount())],
    ['node rss mb', String(Math.round(process.memoryUsage().rss / 1024 / 1024))],
  );
  return {
    text: renderRowTable({
      title: 'Biowasm analysis session',
      summary,
      columns: [],
      rows: [],
      topN: 50,
    }),
  };
}

// ---------------------------------------------------------------------------
// analysis_biowasm_cli.
// ---------------------------------------------------------------------------

export function exitCodeLabel(exitCode: number | null): string {
  return exitCode === null ? 'unknown (no status)' : String(exitCode);
}

export async function runBiowasmCli(
  tool: BiowasmToolName,
  args: string[],
  output: CanonicalOutput,
): Promise<AnalyzerResult> {
  validateCliArgs(tool, args);
  const results: BiowasmRunResult[] = [];
  // raw: this tool exists to surface raw diagnostics — it must render
  // nonzero exit codes and fatal stderr instead of throwing.
  const res = await runEngine(results, `${tool} ${args.join(' ')}`, { tool, args, stdout: 'capture' }, { raw: true });
  const failed = looksFailed(res);
  const io = aggregate(results);
  const text = captured(res);
  const lines = text.split('\n').filter((l) => l !== '');
  const stderr = res.stderr.trim();

  if (output.format === 'json') {
    return toJson({
      kind: 'biowasm_cli',
      tool,
      args,
      exit_code: res.exitCode,
      is_error: failed,
      stdout: clipText(text, 512 * 1024),
      stderr: clipText(stderr, 64 * 1024),
      is_truncated: res.stdout.mode === 'capture' && res.stdout.truncated,
      io_stats: ioStatsPayload(io.bytesRead, io.elapsedMs),
    });
  }
  const summary: Array<[string, string]> = [
    ['exit code', exitCodeLabel(res.exitCode)],
    ['is_error', failed ? 'true' : 'false'],
    ['stdout lines', String(lines.length)],
    ...(stderr ? [['stderr lines', String(stderr.split('\n').length)] as [string, string]] : []),
  ];
  let rendered = renderTextTable(`${tool} ${args.join(' ')}`, summary, text, output.topN, 'output lines');
  if (failed) {
    rendered += '\n\n**error:** the tool reported a failure (see stderr below).';
  }
  if (stderr) {
    rendered += '\n\nstderr:\n\n```\n' + clipText(stderr, 2048) + '\n```';
  }
  const trunc = truncationNote(res);
  return { text: rendered + '\n\n' + ioStatsLine(io.bytesRead, io.elapsedMs) + (trunc ? `\n\n${trunc}` : '') };
}

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import type { BiowasmInputFile, BiowasmMount, BiowasmToolName } from './engine.js';
import {
  DEFAULT_PROJECTION_FIELDS,
  type FieldName,
  type IndexInput,
  type OutputInput,
  type ProjectionInput,
  type RegionInput,
  type SourceInput,
} from './schemas.js';
import { resolveArtifact } from './artifacts.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const DATA_DIR_ENV_VAR = 'ANALYSIS_BIOWASM_DATA_DIR';

const DOT_DOT_SEGMENT = /(^|\/)\.\.($|\/)/;
const INDEX_SUFFIXES = ['.bai', '.csi', '.tbi', '.crai'] as const;

export function dataDirRoot(): string | null {
  const raw = process.env[DATA_DIR_ENV_VAR];
  if (!raw || raw.trim() === '') return null;
  return resolve(raw);
}

export function resolveHostDataPath(raw: string): string {
  if (DOT_DOT_SEGMENT.test(raw)) {
    throw new ValidationError(`host_path "${raw}" must not contain ".." segments.`);
  }
  const root = dataDirRoot();
  if (!root) {
    throw new ValidationError(
      `${DATA_DIR_ENV_VAR} is not set; host_path sources are disabled by default. ` +
        `Set it to the absolute path of the directory you want to allow, then pass host_path inside it.`,
    );
  }
  const p = resolve(raw);
  if (p !== root && !p.startsWith(root + sep)) {
    throw new ValidationError(
      `host_path "${raw}" resolves to ${p}, outside the ${DATA_DIR_ENV_VAR} allowlist root ${root}.`,
    );
  }
  if (!existsSync(p)) {
    throw new ValidationError(`host_path "${raw}" (${p}) does not exist.`);
  }
  return p;
}

export type SniffedFormat = 'sam' | 'vcf' | 'bed' | 'text';

export function sniffTextFormat(content: string): SniffedFormat {
  const head = content.slice(0, 4096);
  if (/^##fileformat=VCF/m.test(head)) return 'vcf';
  if (/^@(HD|SQ|RG|PG|CO)\b/m.test(head)) return 'sam';
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('track') || t.startsWith('browser')) continue;
    const f = t.split('\t');
    if (f.length >= 3 && /^\d+$/.test(f[1]) && /^\d+$/.test(f[2])) return 'bed';
    break;
  }
  return 'text';
}

function extForFormat(format: SniffedFormat): string {
  if (format === 'sam') return 'sam';
  if (format === 'vcf') return 'vcf';
  if (format === 'bed') return 'bed';
  return 'txt';
}

function indexExtForMain(mainName: string): string {
  if (mainName.endsWith('.bam') || mainName.endsWith('.sam')) return 'bai';
  if (mainName.endsWith('.cram')) return 'crai';
  if (mainName.endsWith('.vcf.gz') || mainName.endsWith('.vcf')) return 'tbi';
  return 'csi';
}

function vfsNameForHost(hostPath: string): string {
  const hash = createHash('sha256').update(hostPath).digest('hex').slice(0, 8);
  return `${hash}-${basename(hostPath)}`;
}

function extOf(hostPath: string): string {
  return extname(hostPath).replace(/^\./, '') || 'idx';
}

export interface ResolvedSource {
  kind: 'content' | 'artifact' | 'host_path';
  label: string;
  vfsPath: string;
  inputs: BiowasmInputFile[];
  mounts: BiowasmMount[];
  hasIndex: boolean;
  approxBytes: number;
}

export function canonicalizeSource(source: SourceInput, index: IndexInput = 'auto'): ResolvedSource {
  if ('content' in source) {
    const format = sniffTextFormat(source.content);
    const name = `in-${createHash('sha256').update(source.content).digest('hex').slice(0, 12)}.${extForFormat(format)}`;
    const inputs: BiowasmInputFile[] = [{ name, content: source.content }];
    let hasIndex = false;
    if (index !== 'auto' && 'content' in index) {
      inputs.push({ name: `${name}.${indexExtForMain(name)}`, content: index.content });
      hasIndex = true;
    }
    return {
      kind: 'content',
      label: `in-band content (${name})`,
      vfsPath: `/shared/data/${name}`,
      inputs,
      mounts: [],
      hasIndex,
      approxBytes: source.content.length,
    };
  }

  let hostPath: string;
  let label: string;
  if ('artifact_id' in source) {
    const record = resolveArtifact(source.artifact_id);
    if (!record) {
      throw new ValidationError(
        `artifact_id "${source.artifact_id}" was not found (or its file is gone). Use an artifact_id from a previous analysis_biowasm_* response.`,
      );
    }
    hostPath = record.hostPath;
    label = `artifact ${record.id} (${record.description})`;
  } else {
    hostPath = resolveHostDataPath(source.host_path);
    label = `host file ${hostPath}`;
  }

  const vfsName = vfsNameForHost(hostPath);
  const vfsPath = `/shared/data/${vfsName}`;
  const mounts: BiowasmMount[] = [{ hostPath, vfsPath }];
  const inputs: BiowasmInputFile[] = [];
  let hasIndex = false;

  if (index === 'auto') {
    for (const suffix of INDEX_SUFFIXES) {
      const idxHost = `${hostPath}${suffix}`;
      if (existsSync(idxHost)) {
        mounts.push({ hostPath: idxHost, vfsPath: `${vfsPath}${suffix}` });
        hasIndex = true;
        break;
      }
    }
  } else if ('host_path' in index) {
    const idxHost = resolveHostDataPath(index.host_path);
    mounts.push({ hostPath: idxHost, vfsPath: `${vfsPath}.${extOf(idxHost)}` });
    hasIndex = true;
  } else {
    inputs.push({ name: `${vfsName}.${indexExtForMain(vfsName)}`, content: index.content });
    hasIndex = true;
  }

  return {
    kind: 'artifact_id' in source ? 'artifact' : 'host_path',
    label,
    vfsPath,
    inputs,
    mounts,
    hasIndex,
    approxBytes: 0,
  };
}

export function mergeSources(a: ResolvedSource, b: ResolvedSource | undefined): Pick<ResolvedSource, 'inputs' | 'mounts'> {
  return {
    inputs: [...a.inputs, ...(b?.inputs ?? [])],
    mounts: [...a.mounts, ...(b?.mounts ?? [])],
  };
}

export function formatRegion(region: RegionInput): string {
  const { chrom, start, end } = region;
  if (start !== undefined && end !== undefined) return `${chrom}:${start}-${end}`;
  if (start !== undefined) return `${chrom}:${start}`;
  if (end !== undefined) return `${chrom}:1-${end}`;
  return chrom;
}

const FIELD_FORMAT: Record<FieldName, string> = {
  CHROM: '%CHROM',
  POS: '%POS',
  ID: '%ID',
  REF: '%REF',
  ALT: '%ALT',
  QUAL: '%QUAL',
  FILTER: '%FILTER',
  INFO: '%INFO',
  AF: '%INFO/AF',
  AC: '%INFO/AC',
  AN: '%INFO/AN',
  DP: '%INFO/DP',
  TYPE: '%TYPE',
  GT: '[%GT]',
  GQ: '[%GQ]',
  DP_SAMPLE: '[%DP]',
  AD: '[%AD]',
};

export function composeQueryFormat(fields: readonly FieldName[]): string {
  return `${fields.map((f) => FIELD_FORMAT[f]).join('\t')}\n`;
}

export interface CanonicalProjection {
  fields: FieldName[];
  samples?: string[];
}

export function canonicalizeProjection(projection?: ProjectionInput): CanonicalProjection {
  return {
    fields: projection?.fields ?? [...DEFAULT_PROJECTION_FIELDS],
    samples: projection?.samples,
  };
}

export interface CanonicalOutput {
  format: 'table' | 'json' | 'artifact';
  topN: number;
  includeContent: boolean;
}

export function canonicalizeOutput(output?: Pick<OutputInput, 'format' | 'top_n' | 'include_content'>): CanonicalOutput {
  return {
    format: output?.format ?? 'table',
    topN: output?.top_n ?? 50,
    includeContent: output?.include_content ?? false,
  };
}

export const MAX_CLI_ARGS = 32;

export const CLI_SUBCOMMANDS: Record<BiowasmToolName, readonly string[]> = {
  samtools: ['view', 'sort', 'index', 'flagstat', 'idxstats', 'depth', 'mpileup', 'faidx', 'stats', 'quickcheck'],
  bedtools: ['intersect', 'merge', 'subtract', 'coverage', 'jaccard', 'sort', 'bamtobed', 'bedtobam'],
  bcftools: ['view', 'query', 'index', 'stats', 'filter', 'norm', 'concat', 'sort'],
};

const SHELL_METACHARS = /[;&|<>`$()]/;
const PATH_LIKE = /\/|\.(bam|sam|cram|bai|csi|tbi|crai|vcf|bcf|bed|gz|tsv|csv|txt|fa|fasta|fna|dat)$/i;

export function validateCliArgs(tool: BiowasmToolName, args: string[]): void {
  if (args.length === 0) {
    throw new ValidationError(`args must contain at least the ${tool} subcommand.`);
  }
  if (args.length > MAX_CLI_ARGS) {
    throw new ValidationError(`args has ${args.length} entries; maximum is ${MAX_CLI_ARGS}.`);
  }
  const subcommand = args[0];
  const allowlist = CLI_SUBCOMMANDS[tool];
  if (!allowlist.includes(subcommand)) {
    throw new ValidationError(
      `${tool} subcommand "${subcommand}" is not on the allowlist (${allowlist.join(', ')}). ` +
        'Prefer the analysis_bam_/analysis_bcf_/analysis_bed_ workflow tools, which cover the common subcommands.',
    );
  }
  for (const arg of args) {
    if (SHELL_METACHARS.test(arg)) {
      throw new ValidationError(
        `arg "${arg}" contains a shell metacharacter. Args are passed to the tool directly (no shell); ` +
          'expression filters belong in analysis_bcf_view_region / analysis_biowasm_convert.',
      );
    }
    if (DOT_DOT_SEGMENT.test(arg)) {
      throw new ValidationError(`arg "${arg}" must not contain ".." segments.`);
    }
    if (PATH_LIKE.test(arg) && arg !== '/shared' && !arg.startsWith('/shared/')) {
      throw new ValidationError(
        `path-like arg "${arg}" must live under /shared (in-band inputs land in /shared/data; write outputs to /shared/out).`,
      );
    }
  }
}

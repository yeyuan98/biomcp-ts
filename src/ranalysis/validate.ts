import { z } from 'zod';

export const MAX_GENES = 50_000;
export const MAX_SAMPLES = 64;
export const MAX_CELLS = MAX_GENES * MAX_SAMPLES;
export const MAX_INPUT_CHARS = 20 * 1024 * 1024;
export const MAX_TOP_N = 200;
export const DEFAULT_TOP_N = 50;

export interface CanonicalCounts {
  genes: string[];
  samples: string[];
  matrix: number[][];
}

export interface CanonicalColdata {
  samples: string[];
  columns: Record<string, Array<string | number>>;
}

export interface CanonicalContrast {
  variable: string;
  numerator: string;
  denominator: string;
}

export type ColdataValue = string | number;

export interface CanonicalAnalysisRequest {
  counts: CanonicalCounts;
  coldata: CanonicalColdata;
  design: string;
  contrast?: CanonicalContrast;
  coef?: string;
  topN: number;
  includeFull: boolean;
  format: 'table' | 'json';
}

const countsObjectSchema = z.object({
  genes: z.array(z.string().min(1).max(512)).min(1),
  samples: z.array(z.string().min(1).max(512)).min(2),
  matrix: z.array(z.array(z.number())),
});

const coldataObjectSchema = z.object({
  samples: z.array(z.string().min(1).max(512)).min(2),
  columns: z.record(z.string().min(1).max(512), z.array(z.union([z.string().max(512), z.number()]))),
});

const contrastSchema = z.object({
  variable: z.string().min(1).max(512),
  numerator: z.string().min(1).max(512),
  denominator: z.string().min(1).max(512),
});

export const analysisInputSchema = z.object({
  counts: z.union([countsObjectSchema, z.string().min(1)]).describe(
    'Gene x sample raw integer count matrix. Either an object {genes: string[], samples: string[], matrix: number[][]} (matrix rows follow genes, columns follow samples) or a CSV string with header row of sample names and first column of gene IDs.'
  ),
  coldata: z.union([coldataObjectSchema, z.string().min(1)]).describe(
    'Sample metadata. Either an object {samples: string[], columns: {[name]: (string|number)[]}} or a CSV string with header row of column names and first column of sample IDs. Character columns become factors; use them in the design formula.'
  ),
  design: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'RHS design formula, e.g. "condition" or "batch + condition". Variables must be coldata columns. Supports +, *, :, ( ), and 0/1 intercept terms.'
    ),
  contrast: contrastSchema
    .optional()
    .describe(
      'Contrast as {variable, numerator, denominator}, e.g. {variable: "condition", numerator: "treated", denominator: "control"} reports numerator vs denominator. Optional; defaults to the last term of the design.'
    ),
  coef: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'Model matrix coefficient name to test (edgeR/limma), e.g. "conditiontreated". Optional; conflicts with contrast; defaults to the last design column.'
    ),
  top_n: z.number().int().min(1).max(MAX_TOP_N).optional().describe(`Number of top rows to return in the table (default ${DEFAULT_TOP_N}, max ${MAX_TOP_N}).`),
  include_full: z
    .boolean()
    .optional()
    .describe(
      'Include the full results table as base64(gzip(TSV)) in the response (default false). Decode: gunzip after base64-decode.'
    ),
  format: z.enum(['table', 'json']).optional().describe('Response format: "table" (markdown, default) or "json" (structured).'),
});

export type AnalysisToolInput = z.infer<typeof analysisInputSchema>;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) throw new ValidationError('CSV input is empty.');
  const width = rows[0].length;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].length !== width) {
      throw new ValidationError(`CSV row ${r + 1} has ${rows[r].length} fields, expected ${width}.`);
    }
  }
  return rows;
}

function canonicalizeCountsCsv(text: string): CanonicalCounts {
  const rows = parseCsv(text);
  const header = rows[0].slice(1);
  const samples = header.map((h) => h.trim());
  if (samples.length < 2) throw new ValidationError('Counts CSV must have at least 2 sample columns.');
  if (samples.some((s) => s === '')) throw new ValidationError('Counts CSV header contains an empty sample name.');
  const genes: string[] = [];
  const matrix: number[][] = [];
  for (let r = 1; r < rows.length; r++) {
    const gene = rows[r][0].trim();
    if (gene === '') throw new ValidationError(`Counts CSV row ${r + 1} has an empty gene ID.`);
    genes.push(gene);
    const row: number[] = [];
    for (let c = 1; c < rows[r].length; c++) {
      const raw = rows[r][c].trim();
      const v = Number(raw);
      if (raw === '' || !Number.isFinite(v)) {
        throw new ValidationError(`Counts CSV cell (row ${r + 1}, column ${c + 1}) is not a finite number: "${raw}".`);
      }
      row.push(v);
    }
    matrix.push(row);
  }
  return { genes, samples, matrix };
}

function canonicalizeColdataCsv(text: string): CanonicalColdata {
  const rows = parseCsv(text);
  const header = rows[0].slice(1);
  const names = header.map((h) => h.trim());
  if (names.some((s) => s === '')) throw new ValidationError('Coldata CSV header contains an empty column name.');
  const samples: string[] = [];
  const columns: Record<string, Array<string | number>> = {};
  for (const name of names) columns[name] = [];
  for (let r = 1; r < rows.length; r++) {
    const sample = rows[r][0].trim();
    if (sample === '') throw new ValidationError(`Coldata CSV row ${r + 1} has an empty sample ID.`);
    samples.push(sample);
    for (let c = 1; c < rows[r].length; c++) {
      const raw = rows[r][c].trim();
      const num = Number(raw);
      columns[names[c - 1]].push(raw !== '' && Number.isFinite(num) ? num : raw);
    }
  }
  return { samples, columns };
}

function validateCounts(counts: CanonicalCounts): void {
  const { genes, samples, matrix } = counts;
  if (genes.length > MAX_GENES) {
    throw new ValidationError(`Counts matrix has ${genes.length} genes; maximum is ${MAX_GENES}.`);
  }
  if (samples.length > MAX_SAMPLES) {
    throw new ValidationError(`Counts matrix has ${samples.length} samples; maximum is ${MAX_SAMPLES}.`);
  }
  const cells = genes.length * samples.length;
  if (cells > MAX_CELLS) {
    throw new ValidationError(`Counts matrix has ${cells} cells; maximum is ${MAX_CELLS}.`);
  }
  const dupGenes = findDuplicates(genes);
  if (dupGenes.length > 0) {
    throw new ValidationError(`Duplicate gene IDs not allowed: ${dupGenes.slice(0, 5).join(', ')}${dupGenes.length > 5 ? ', …' : ''}.`);
  }
  const dupSamples = findDuplicates(samples);
  if (dupSamples.length > 0) {
    throw new ValidationError(`Duplicate sample names not allowed: ${dupSamples.slice(0, 5).join(', ')}${dupSamples.length > 5 ? ', …' : ''}.`);
  }
  if (matrix.length !== genes.length) {
    throw new ValidationError(`Matrix has ${matrix.length} rows but ${genes.length} genes were given.`);
  }
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r];
    if (row.length !== samples.length) {
      throw new ValidationError(`Matrix row ${r + 1} (gene ${genes[r]}) has ${row.length} values but ${samples.length} samples were given.`);
    }
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (!Number.isFinite(v)) {
        throw new ValidationError(`Matrix cell (gene ${genes[r]}, sample ${samples[c]}) is not finite.`);
      }
      if (v < 0) {
        throw new ValidationError(`Matrix cell (gene ${genes[r]}, sample ${samples[c]}) is negative: ${v}. Raw counts must be >= 0.`);
      }
      if (!Number.isInteger(v)) {
        throw new ValidationError(`Matrix cell (gene ${genes[r]}, sample ${samples[c]}) is not an integer: ${v}. Raw counts must be integers.`);
      }
    }
  }
}

function validateColdata(coldata: CanonicalColdata, counts: CanonicalCounts): void {
  const dupSamples = findDuplicates(coldata.samples);
  if (dupSamples.length > 0) {
    throw new ValidationError(`Duplicate sample names in coldata not allowed: ${dupSamples.join(', ')}.`);
  }
  const countSet = new Set(counts.samples);
  const colSet = new Set(coldata.samples);
  const missingInColdata = counts.samples.filter((s) => !colSet.has(s));
  const extraInColdata = coldata.samples.filter((s) => !countSet.has(s));
  if (missingInColdata.length > 0 || extraInColdata.length > 0) {
    const parts: string[] = [];
    if (missingInColdata.length > 0) parts.push(`missing from coldata: ${missingInColdata.join(', ')}`);
    if (extraInColdata.length > 0) parts.push(`not in counts: ${extraInColdata.join(', ')}`);
    throw new ValidationError(`Sample names in counts and coldata must match exactly (${parts.join('; ')}).`);
  }
  for (const [name, values] of Object.entries(coldata.columns)) {
    if (values.length !== coldata.samples.length) {
      throw new ValidationError(`Coldata column "${name}" has ${values.length} values but ${coldata.samples.length} samples were given.`);
    }
    const uniq = new Set(values.map((v) => String(v)));
    if (uniq.size < 2) {
      throw new ValidationError(`Coldata column "${name}" has a single unique value; it cannot model a contrast.`);
    }
  }
}

const FORMULA_DENYLIST = new Set([
  'q', 'quit', 'eval', 'parse', 'get', 'load', 'source', 'install', 'library',
  'require', 'system', 'system2', 'dyn', 'dyn_load', 'dyn.load', 'search',
  'attach', 'detach', 'rm', 'unlink', 'read', 'readRDS', 'save', 'saveRDS',
]);

function validateDesign(design: string, coldata: CanonicalColdata): void {
  const trimmed = design.trim();
  if (!/^[A-Za-z0-9_ +*():.]+$/.test(trimmed)) {
    throw new ValidationError(
      `Design formula contains disallowed characters (allowed: letters, digits, underscore, space, + * : ( ) .): "${trimmed}".`
    );
  }
  const identifiers = trimmed.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
  const known = new Set(Object.keys(coldata.columns));
  const unknown: string[] = [];
  for (const id of identifiers) {
    if (FORMULA_DENYLIST.has(id)) {
      throw new ValidationError(`Design formula contains a disallowed token: "${id}".`);
    }
    if (!known.has(id)) unknown.push(id);
  }
  if (unknown.length > 0) {
    throw new ValidationError(
      `Design formula references unknown coldata column(s): ${unknown.join(', ')}. Available columns: ${[...known].join(', ')}.`
    );
  }
  if (identifiers.length === 0) {
    throw new ValidationError('Design formula contains no variables.');
  }
}

function validateContrast(contrast: CanonicalContrast, coldata: CanonicalColdata): void {
  const values = coldata.columns[contrast.variable];
  if (values === undefined) {
    throw new ValidationError(
      `Contrast variable "${contrast.variable}" is not a coldata column. Available columns: ${Object.keys(coldata.columns).join(', ')}.`
    );
  }
  const asStrings = new Set(values.map((v) => String(v)));
  for (const level of [contrast.numerator, contrast.denominator]) {
    if (!asStrings.has(level)) {
      throw new ValidationError(
        `Contrast level "${level}" not found in coldata column "${contrast.variable}" (observed: ${[...asStrings].join(', ')}).`
      );
    }
  }
  if (contrast.numerator === contrast.denominator) {
    throw new ValidationError('Contrast numerator and denominator must differ.');
  }
}

const UNSAFE_ID_CHARS = /["\r\n\t]/;

function rejectUnsafeStrings(kind: string, values: string[]): void {
  for (const v of values) {
    if (UNSAFE_ID_CHARS.test(v)) {
      throw new ValidationError(
        `${kind} contains a double quote or control character (not representable in the CSV interchange): ${JSON.stringify(v.slice(0, 60))}.`
      );
    }
  }
}

function findDuplicates(items: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) dups.add(item);
    seen.add(item);
  }
  return [...dups];
}

function reorderColdata(coldata: CanonicalColdata, sampleOrder: string[]): CanonicalColdata {
  const index = new Map(coldata.samples.map((s, i) => [s, i]));
  const columns: Record<string, Array<string | number>> = {};
  for (const [name, values] of Object.entries(coldata.columns)) {
    columns[name] = sampleOrder.map((s) => values[index.get(s)!]);
  }
  return { samples: [...sampleOrder], columns };
}

export function canonicalizeAnalysisInput(input: AnalysisToolInput): CanonicalAnalysisRequest {
  if (typeof input.counts === 'string' && input.counts.length > MAX_INPUT_CHARS) {
    throw new ValidationError(`Counts input exceeds ${MAX_INPUT_CHARS} characters.`);
  }
  if (typeof input.coldata === 'string' && input.coldata.length > MAX_INPUT_CHARS) {
    throw new ValidationError(`Coldata input exceeds ${MAX_INPUT_CHARS} characters.`);
  }
  const counts: CanonicalCounts =
    typeof input.counts === 'string' ? canonicalizeCountsCsv(input.counts) : { ...input.counts };
  const coldataRaw: CanonicalColdata =
    typeof input.coldata === 'string' ? canonicalizeColdataCsv(input.coldata) : { ...input.coldata };

  rejectUnsafeStrings('Gene IDs', counts.genes);
  rejectUnsafeStrings('Sample names', counts.samples);
  for (const [name, values] of Object.entries(coldataRaw.columns)) {
    rejectUnsafeStrings(`Coldata column "${name}" name`, [name]);
    rejectUnsafeStrings(
      `Coldata column "${name}" values`,
      values.filter((v): v is string => typeof v === 'string')
    );
  }
  validateCounts(counts);
  validateColdata(coldataRaw, counts);
  const coldata = reorderColdata(coldataRaw, counts.samples);
  validateDesign(input.design, coldata);

  if (input.contrast && input.coef) {
    throw new ValidationError('Provide either contrast or coef, not both.');
  }
  if (input.contrast) validateContrast(input.contrast, coldata);

  return {
    counts,
    coldata,
    design: input.design.trim(),
    contrast: input.contrast,
    coef: input.coef,
    topN: input.top_n ?? DEFAULT_TOP_N,
    includeFull: input.include_full ?? false,
    format: input.format ?? 'table',
  };
}

export function toCountsCsv(request: CanonicalAnalysisRequest): string {
  const header = ['gene', ...request.counts.samples].join(',');
  const rows = request.counts.genes.map((gene, r) => {
    const row = request.counts.matrix[r].map((v) => String(v));
    return [JSON.stringify(gene), ...row].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

export function toColdataCsv(request: CanonicalAnalysisRequest): string {
  const names = Object.keys(request.coldata.columns);
  const header = ['sample', ...names].join(',');
  const rows = request.coldata.samples.map((sample, i) => {
    const vals = names.map((n) => {
      const v = request.coldata.columns[n][i];
      return typeof v === 'number' ? String(v) : JSON.stringify(v);
    });
    return [JSON.stringify(sample), ...vals].join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

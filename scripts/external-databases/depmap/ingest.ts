import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { parseCsvFile } from './csv.js';
import {
  BASE_TABLE_DDLS,
  buildModelsTable,
  GENE_REQUIRED_COLUMNS,
  matrixTableDdl,
  MODELS_PINNED_COLUMNS,
  MUTATION_COLUMNS,
} from './schema.js';

const BATCH_OPS = 200_000;

const nodeRequire = createRequire(import.meta.url);

export function loadSqlite(): typeof import('node:sqlite') {
  return nodeRequire('node:sqlite') as typeof import('node:sqlite');
}

export interface IngestResult {
  datasetId: string;
  filename: string;
  rowCount: number;
  details: string;
}

export function createDatabase(path: string): DatabaseSync {
  const db = new (loadSqlite().DatabaseSync)(path);
  db.exec('PRAGMA journal_mode=OFF');
  db.exec('PRAGMA synchronous=OFF');
  db.exec('PRAGMA cache_size=-262144');
  for (const ddl of BASE_TABLE_DDLS) db.exec(ddl);
  return db;
}

function isMissingCell(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'NaN' || value === 'nan';
}

function stripEntrezSuffix(header: string): string {
  return header.replace(/ \(\d+\)$/, '').trim();
}

export async function ingestModels(db: DatabaseSync, file: string): Promise<IngestResult> {
  let schema: ReturnType<typeof buildModelsTable> | null = null;
  const rows: string[][] = [];
  for await (const row of parseCsvFile(file)) {
    if (!schema) {
      schema = buildModelsTable(row);
      db.exec(schema.ddl);
      continue;
    }
    rows.push(row);
  }
  if (!schema) throw new Error(`Model.csv has no header: ${file}`);
  const stmt = db.prepare(`INSERT INTO models VALUES (${schema.columns.map(() => '?').join(',')})`);
  let inserted = 0;
  db.exec('BEGIN');
  for (const row of rows) {
    row.length = schema.columns.length;
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null as unknown as string;
    try {
      stmt.run(...row);
      inserted++;
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`Model.csv insert failed at row for ${row[0] ?? '?'}: ${String(error)}`);
    }
  }
  db.exec('COMMIT');
  if (inserted !== rows.length) {
    throw new Error(`Model.csv inserted ${inserted} of ${rows.length} rows`);
  }
  const extra = schema.addedColumns.length > 0 ? `, ${schema.addedColumns.length} new column(s) ingested` : '';
  const map = JSON.stringify(schema.columns.map(c => [c.original, c.sql]));
  db.prepare('INSERT OR REPLACE INTO depmap_meta VALUES (?, ?)').run('models_column_map', map);
  db.prepare('INSERT OR REPLACE INTO depmap_meta VALUES (?, ?)').run(
    'models_pinned_columns',
    JSON.stringify(MODELS_PINNED_COLUMNS)
  );
  return {
    datasetId: 'models',
    filename: basename(file),
    rowCount: inserted,
    details: `${schema.columns.length} columns${extra}`,
  };
}

export async function ingestGenes(db: DatabaseSync, file: string): Promise<IngestResult> {
  let header: string[] | null = null;
  const idx: Record<string, number> = {};
  const stmt = db.prepare('INSERT OR IGNORE INTO genes VALUES (?, ?, ?)');
  let source = 0;
  let inserted = 0;
  let ignored = 0;
  db.exec('BEGIN');
  let ops = 0;
  for await (const row of parseCsvFile(file)) {
    if (!header) {
      header = row;
      for (const col of GENE_REQUIRED_COLUMNS) {
        idx[col] = header.indexOf(col);
        if (idx[col] === -1) throw new Error(`Gene.csv is missing required column "${col}"`);
      }
      continue;
    }
    source++;
    const symbol = row[idx.symbol]?.trim();
    if (!symbol) continue;
    let entrez: number | null = null;
    const raw = row[idx.entrez_id]?.trim();
    if (raw) {
      const num = Number(raw);
      if (Number.isFinite(num)) entrez = Math.trunc(num);
    }
    const result = stmt.run(symbol, entrez, row[idx.name] ?? null);
    if (result.changes === 1) inserted++;
    else ignored++;
    if (++ops % BATCH_OPS === 0) {
      db.exec('COMMIT');
      db.exec('BEGIN');
    }
  }
  db.exec('COMMIT');
  return {
    datasetId: 'genes',
    filename: basename(file),
    rowCount: inserted,
    details: `${source} source rows, ${ignored} duplicate symbol(s) ignored`,
  };
}

export async function ingestControls(
  db: DatabaseSync,
  files: { file: string; category: string }[]
): Promise<IngestResult[]> {
  const stmt = db.prepare('INSERT OR IGNORE INTO essentiality_controls VALUES (?, ?)');
  const results: IngestResult[] = [];
  for (const { file, category } of files) {
    let header: string[] | null = null;
    let inserted = 0;
    let ignored = 0;
    db.exec('BEGIN');
    for await (const row of parseCsvFile(file)) {
      if (!header) {
        header = row;
        continue;
      }
      const symbol = stripEntrezSuffix(row[0] ?? '');
      if (!symbol) continue;
      const result = stmt.run(symbol, category);
      if (result.changes === 1) inserted++;
      else ignored++;
    }
    db.exec('COMMIT');
    results.push({
      datasetId: 'common_essentials',
      filename: basename(file),
      rowCount: inserted,
      details: `category=${category}, ${ignored} duplicate(s) ignored`,
    });
  }
  return results;
}

export async function ingestMatrix(
  db: DatabaseSync,
  file: string,
  table: string,
  mode: 'positional' | 'named'
): Promise<IngestResult> {
  db.exec(matrixTableDdl(table));
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} VALUES (?, ?, ?)`);
  let header: string[] | null = null;
  let geneSymbols: string[] | null = null;
  let modelIdx = -1;
  let flagIdx = -1;
  let geneStart = -1;
  const seenModels = new Set<string>();
  let profiles = 0;
  let nonDefaultSkipped = 0;
  let duplicateProfilesSkipped = 0;
  let inserted = 0;
  let ignored = 0;
  let emptySkipped = 0;
  db.exec('BEGIN');
  let ops = 0;
  for await (const row of parseCsvFile(file)) {
    if (!header) {
      header = row;
      if (mode === 'positional') {
        modelIdx = 0;
        geneStart = 1;
      } else {
        modelIdx = header.indexOf('ModelID');
        flagIdx = header.indexOf('IsDefaultEntryForModel');
        geneStart = flagIdx + 1;
        if (modelIdx === -1 || flagIdx === -1) {
          throw new Error(
            `${file}: expected "ModelID" and "IsDefaultEntryForModel" columns for a named-mode matrix`
          );
        }
      }
      geneSymbols = header.slice(geneStart).map(stripEntrezSuffix);
      const seen = new Set<string>();
      for (const symbol of geneSymbols) {
        if (seen.has(symbol)) {
          throw new Error(`${file}: duplicate gene column "${symbol}" after stripping entrez suffixes`);
        }
        seen.add(symbol);
      }
      continue;
    }
    profiles++;
    if (mode === 'named' && row[flagIdx] !== 'Yes') {
      nonDefaultSkipped++;
      continue;
    }
    const modelId = row[modelIdx]?.trim();
    if (!modelId) continue;
    if (seenModels.has(modelId)) {
      duplicateProfilesSkipped++;
      continue;
    }
    seenModels.add(modelId);
    for (let i = geneStart; i < header.length; i++) {
      const value = row[i];
      if (isMissingCell(value)) {
        emptySkipped++;
        continue;
      }
      const result = stmt.run(modelId, geneSymbols![i - geneStart], Number(value));
      if (result.changes === 1) inserted++;
      else ignored++;
      if (++ops % BATCH_OPS === 0) {
        db.exec('COMMIT');
        db.exec('BEGIN');
      }
    }
  }
  db.exec('COMMIT');
  if (ignored > 0) {
    throw new Error(`${file}: ${ignored} duplicate (model, gene) pairs were ignored — source data changed shape`);
  }
  db.exec(`CREATE INDEX idx_${table}_gene ON ${table}(gene_symbol)`);
  return {
    datasetId: table,
    filename: basename(file),
    rowCount: inserted,
    details:
      `${profiles} profile rows, ${seenModels.size} models, ${emptySkipped} empty cells skipped` +
      (mode === 'named' ? `, ${nonDefaultSkipped} non-default profiles skipped, ${duplicateProfilesSkipped} duplicate profiles skipped` : ''),
  };
}

export async function ingestMutations(db: DatabaseSync, file: string): Promise<IngestResult> {
  let header: string[] | null = null;
  const idx: Record<string, number> = {};
  const targets = Object.keys(MUTATION_COLUMNS);
  const stmt = db.prepare(`INSERT INTO mutations VALUES (${targets.map(() => '?').join(',')})`);
  let inserted = 0;
  db.exec('BEGIN');
  let ops = 0;
  for await (const row of parseCsvFile(file)) {
    if (!header) {
      header = row;
      for (const [target, source] of Object.entries(MUTATION_COLUMNS)) {
        idx[target] = header.indexOf(source);
        if (idx[target] === -1) {
          throw new Error(`OmicsSomaticMutations.csv is missing pinned column "${source}" (target ${target})`);
        }
      }
      continue;
    }
    const text = (target: string): string | null => {
      const value = row[idx[target]];
      return value === undefined || value === '' ? null : value;
    };
    const numeric = (target: string): number | null => {
      const value = row[idx[target]];
      if (value === undefined || value === '') return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };
    const int = (target: string): number | null => {
      const num = numeric(target);
      return num === null ? null : Math.trunc(num);
    };
    const booleanish = (target: string): number | null => {
      const value = row[idx[target]];
      if (value === 'True' || value === 'Yes') return 1;
      if (value === 'False' || value === 'No') return 0;
      return null;
    };
    stmt.run(
      text('model_id'), text('hugo_symbol'), int('entrez_gene_id'), text('chromosome'),
      int('position'), text('ref'), text('alt'), text('variant_type'), text('variant_info'),
      text('dna_change'), text('protein_change'), text('gt'), int('ref_count'), int('alt_count'),
      numeric('af'), int('dp'), text('molecular_consequence'), text('vep_impact'),
      booleanish('is_hotspot'), text('hess_driver'), text('hess_signature'), text('likely_lof'),
      numeric('gnomad_e_af'), numeric('gnomad_g_af')
    );
    inserted++;
    if (++ops % BATCH_OPS === 0) {
      db.exec('COMMIT');
      db.exec('BEGIN');
    }
  }
  db.exec('COMMIT');
  return {
    datasetId: 'mutations',
    filename: basename(file),
    rowCount: inserted,
    details: `${targets.length} curated columns`,
  };
}

export function writeMetadata(
  db: DatabaseSync,
  meta: { release: string; releaseDate: string; manifestEndpoint: string; scriptVersion: string },
  datasets: { datasetId: string; filename: string; rowCount: number }[]
): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO depmap_meta VALUES (?, ?)');
  stmt.run('release', meta.release);
  stmt.run('release_date', meta.releaseDate);
  stmt.run('imported_at', new Date().toISOString());
  stmt.run('manifest_endpoint', meta.manifestEndpoint);
  stmt.run('script_version', meta.scriptVersion);
  const datasetStmt = db.prepare('INSERT OR REPLACE INTO dataset VALUES (?, ?, ?, ?)');
  const now = new Date().toISOString();
  for (const d of datasets) datasetStmt.run(d.datasetId, d.filename, d.rowCount, now);
}

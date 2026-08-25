import { realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  IConnectionConfig,
  IConnectionPool,
  IQuery,
  IQueryResult,
  ICollectionInfo,
  IColumnSchema,
  IDatabaseInfo,
} from '../../interface/index.js';
import { BaseBackend } from '../../core/base.js';
import { openReadOnlyDatabase, loadSqliteModule, type SqliteDatabase } from './connection.js';
import {
  mapSqliteTablesToCollections,
  mapPragmaColumnsToSchema,
  describeTable as pragmaDescribeTable,
  parseQualifiedName,
  listTablesSql,
  countRows,
  countTables,
  databaseSizeBytes,
  quoteIdentifier,
} from './translator.js';

import { SQLITE_MAX_DATABASES } from '../../core/env.js';

/** SQLite allows at most 10 attached databases per connection. */
const MAX_ATTACHED_DATABASES = SQLITE_MAX_DATABASES - 1;
/** Schema names that must never be shadowed by an ATTACH alias. */
const RESERVED_ALIASES = new Set(['main', 'temp']);
const MAX_ALIAS_LENGTH = 40;

interface AttachedDatabase {
  alias: string;
  file: string;
}

export class SqliteBackend extends BaseBackend {
  readonly type = 'sqlite';
  readonly config: IConnectionConfig;

  private db: SqliteDatabase | null = null;
  private attached: AttachedDatabase[] = [];

  constructor(config: IConnectionConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    loadSqliteModule();
    const file = this.config.database;
    let stats;
    try {
      stats = statSync(file);
    } catch (error) {
      throw new Error(
        `SQLite database file not found: ${file}\n` +
        'Set DB_SQLITE_PATH to a comma-separated list of existing database files.',
        { cause: error }
      );
    }
    if (!stats.isFile()) {
      throw new Error(`DB_SQLITE_PATH is not a file: ${file}`);
    }
    // A previously failed connect may have left the handle open with a partial
    // set of ATTACHed databases — always reopen fresh so retries are clean.
    if (this.db && !this._connected) {
      try {
        this.db.close();
      } catch {
        // fall through to reopening
      }
      this.db = null;
      this.attached = [];
    }
    if (!this.db) {
      this.db = openReadOnlyDatabase(file);
    }
    this.attached = [];
    this.attachExtraDatabases();
    this.db.prepare('SELECT 1').get();
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        this.db = null;
      }
      this.db = null;
    }
    this.attached = [];
    this._connected = false;
  }

  getPool(): IConnectionPool | null {
    return this.db
      ? {
          getConnection: async () => ({
            isConnected: () => true,
            close: async () => undefined,
          }),
          end: async () => this.disconnect(),
          isHealthy: () => this.db !== null && this._connected,
        }
      : null;
  }

  async executeQuery(query: IQuery): Promise<IQueryResult> {
    const startTime = Date.now();

    try {
      if (!this._connected || !this.db) {
        await this.connect();
      }

      const stmt = this.db!.prepare(query.sql);
      const rows = this.bindAndAll(stmt, query.params);
      const executionTimeMs = Date.now() - startTime;

      return this.createSuccessResult(rows, statementFieldInfo(stmt), executionTimeMs);
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      const result = this.createErrorResult(error, executionTimeMs, this.aliasHintsForError(error));
      if (result.error?.code === 'SQLITE_CANTOPEN') {
        await this.disconnect().catch(() => undefined);
      }
      return result;
    }
  }

  async listCollections(): Promise<ICollectionInfo[]> {
    if (!this._connected || !this.db) {
      await this.connect();
    }
    const collections: ICollectionInfo[] = [];
    for (const schema of this.schemaNames()) {
      const sizeGated = this.databaseSizeBytes(schema) > this.rowCountSizeGateBytes;
      const rows = this.db!.prepare(listTablesSql(schema)).all() as unknown as Parameters<
        typeof mapSqliteTablesToCollections
      >[0];
      for (const info of mapSqliteTablesToCollections(rows)) {
        collections.push({
          ...info,
          database: schema,
          rowCount:
            info.type === 'table' && !sizeGated
              ? countRows(this.db!, info.name, schema)
              : null,
        });
      }
    }
    return collections;
  }

  async describeCollection(name: string): Promise<IColumnSchema[]> {
    if (!this._connected || !this.db) {
      await this.connect();
    }
    const { schema, table } = parseQualifiedName(name);
    if (!this.isValidSchema(schema)) {
      throw new Error(
        `Unknown database "${schema}" in "${name}". Available databases: ${this.schemaNames().join(', ')}. ` +
        'Aliases are listed in the databases array of db_list_tables output.'
      );
    }
    return mapPragmaColumnsToSchema(pragmaDescribeTable(this.db!, table, schema));
  }

  async listDatabases(): Promise<IDatabaseInfo[]> {
    if (!this._connected || !this.db) {
      await this.connect();
    }
    const databases: IDatabaseInfo[] = [
      {
        name: 'main',
        file: resolve(this.config.database),
        tableCount: countTables(this.db!, 'main'),
      },
    ];
    if (this.databaseSizeBytes('main') > this.rowCountSizeGateBytes) {
      databases[0].rowCountOmitted = true;
    }
    for (const { alias, file } of this.attached) {
      const entry: IDatabaseInfo = {
        name: alias,
        file,
        tableCount: countTables(this.db!, alias),
      };
      if (this.databaseSizeBytes(alias) > this.rowCountSizeGateBytes) {
        entry.rowCountOmitted = true;
      }
      databases.push(entry);
    }
    return databases;
  }

  /** Databases larger than this gate omit exact row counts in listings
   * (counting tens of millions of rows is expensive; SELECT COUNT(*) remains
   * available). Overridable for tests. */
  protected get rowCountSizeGateBytes(): number {
    return 256 * 1024 * 1024;
  }

  private schemaNames(): string[] {
    return ['main', ...this.attached.map((entry) => entry.alias)];
  }

  private isValidSchema(schema: string): boolean {
    return schema === 'main' || this.attached.some((entry) => entry.alias === schema);
  }

  private databaseSizeBytes(schema: string): number {
    return databaseSizeBytes(this.db!, schema);
  }

  private attachExtraDatabases(): void {
    const extras = this.config.attach ?? [];
    if (extras.length === 0) {
      return;
    }
    if (extras.length > MAX_ATTACHED_DATABASES) {
      throw new Error(
        `Too many attached databases: DB_SQLITE_PATH lists ${extras.length} extra entries, ` +
        `maximum is ${MAX_ATTACHED_DATABASES}.\nEntries:\n  ${extras.join('\n  ')}`
      );
    }

    let mainRealPath: string;
    try {
      mainRealPath = realpathSync(this.config.database);
    } catch (error) {
      throw new Error(
        `Cannot resolve main SQLite database "${this.config.database}": ${errorMessage(error)}`,
        { cause: error }
      );
    }
    const usedPaths = new Set<string>([mainRealPath]);
    const usedAliases = new Set<string>(RESERVED_ALIASES);

    for (const rawPath of extras) {
      const absolute = resolve(rawPath);
      let realPath: string;
      try {
        realPath = realpathSync(absolute);
      } catch (error) {
        const alias = allocateAlias(absolute, new Set(RESERVED_ALIASES));
        throw new Error(
          `Cannot attach SQLite database "${rawPath}" (alias "${alias}"): ` +
          'file not found. DB_SQLITE_PATH must list existing database files.',
          { cause: error }
        );
      }
      if (usedPaths.has(realPath)) {
        continue;
      }
      usedPaths.add(realPath);

      const alias = allocateAlias(realPath, usedAliases);
      usedAliases.add(alias);

      // URI mode=ro is mandatory: a plain-path ATTACH of a missing file would
      // silently create an empty database instead of failing.
      const uri = `${pathToFileURL(realPath).href}?mode=ro`;
      try {
        this.db!.exec(`ATTACH DATABASE '${sqlEscape(uri)}' AS ${quoteIdentifier(alias)}`);
      } catch (error) {
        throw new Error(
          `Failed to attach SQLite database "${rawPath}" as "${alias}": ${errorMessage(error)}`,
          { cause: error }
        );
      }
      this.attached.push({ alias, file: realPath });
    }
  }

  private aliasHintsForError(error: unknown): string[] | undefined {
    if (this.attached.length === 0) {
      return undefined;
    }
    if (!/no such table/i.test(errorMessage(error))) {
      return undefined;
    }
    return [
      'The table may live in an attached database — qualify it as alias.table; ' +
      'aliases are listed in the databases array of db_list_tables output',
    ];
  }

  private bindAndAll(
    stmt: ReturnType<SqliteDatabase['prepare']>,
    params?: Record<string, unknown> | unknown[]
  ): Record<string, unknown>[] {
    if (params === undefined || (Array.isArray(params) ? params.length === 0 : Object.keys(params).length === 0)) {
      return stmt.all() as Record<string, unknown>[];
    }
    return stmt.all(params as Record<string, never>) as Record<string, unknown>[];
  }
}

function allocateAlias(file: string, used: Set<string>): string {
  const base = sanitizeAliasBase(basename(file));
  let alias = base;
  let suffix = 2;
  while (used.has(alias)) {
    alias = `${base}_${suffix++}`;
  }
  return alias;
}

function sanitizeAliasBase(filename: string): string {
  let base = filename
    .replace(/\.(db|sqlite|sqlite3)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_ALIAS_LENGTH)
    .replace(/_+$/, '');
  if (base === '') {
    base = 'db';
  }
  if (/^[0-9]/.test(base)) {
    base = `_${base}`;
  }
  return base;
}

function sqlEscape(literal: string): string {
  return literal.replace(/'/g, "''");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statementFieldInfo(stmt: ReturnType<SqliteDatabase['prepare']>) {
  try {
    const columns = stmt.columns();
    if (!Array.isArray(columns)) return [];
    return columns.map((col) => ({
      name: col.name ?? 'unknown',
      type: typeof col.type === 'string' && col.type.length > 0 ? col.type : 'unknown',
      nullable: true,
      key: null,
      default: null,
      extra: null,
    }));
  } catch {
    return [];
  }
}

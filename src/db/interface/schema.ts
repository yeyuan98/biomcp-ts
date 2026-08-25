export interface ICollectionInfo {
  name: string;
  type: 'table' | 'view' | 'collection';
  engine?: string | null;
  rowCount?: number | null;
  createdAt?: string | null;
  comment?: string | null;
  /** SQLite multi-database setups: the database (main or ATTACH alias) this
   * collection lives in. Unset for single-database backends. */
  database?: string;
}

export interface IDatabaseInfo {
  /** Schema name: 'main' or an ATTACH alias. */
  name: string;
  /** Absolute path of the underlying database file. */
  file: string;
  tableCount: number;
  /** True when row counts were omitted for this database's tables because it
   * exceeds the size gate (use SELECT COUNT(*) instead). */
  rowCountOmitted?: boolean;
}

export interface IColumnSchema {
  field: string;
  type: string;
  nullable: boolean;
  key: string | null;
  defaultValue: unknown;
  extra: string | null;
  comment?: string | null;
}

export interface ISchemaResult {
  collection: string;
  columns: IColumnSchema[];
  columnCount: number;
}

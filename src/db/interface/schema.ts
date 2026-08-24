export interface ICollectionInfo {
  name: string;
  type: 'table' | 'view' | 'collection';
  engine?: string | null;
  rowCount?: number | null;
  createdAt?: string | null;
  comment?: string | null;
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

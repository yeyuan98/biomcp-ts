import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export type SqliteDatabase = DatabaseSync;

let cachedModule: typeof import('node:sqlite') | null = null;

export function loadSqliteModule(): typeof import('node:sqlite') {
  if (cachedModule) {
    return cachedModule;
  }
  const require = createRequire(import.meta.url);
  try {
    const mod = require('node:sqlite');
    cachedModule = mod;
    return mod;
  } catch (error) {
    throw new Error(
      'The built-in "node:sqlite" module is not available in this Node.js build.\n' +
      'The SQLite backend requires Node.js >= 22.13.0.',
      { cause: error }
    );
  }
}

export function openReadOnlyDatabase(file: string): SqliteDatabase {
  const { DatabaseSync } = loadSqliteModule();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA query_only = ON');
  return db;
}

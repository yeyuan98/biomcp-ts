import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
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
  // mode=ro URI: the file is opened read-only at the VFS level, and a missing
  // file fails instead of being created.
  const db = new DatabaseSync(`${pathToFileURL(file).href}?mode=ro`);
  db.exec('PRAGMA query_only = ON');
  return db;
}

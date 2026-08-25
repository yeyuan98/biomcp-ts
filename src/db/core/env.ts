import type { DatabaseType, IConnectionConfig } from '../interface/index.js';
import { validateBaseConfig } from '../interface/connection.js';

export const SUPPORTED_DB_TYPES: readonly DatabaseType[] = ['mysql', 'sqlite'];

/** 1 main database + SQLite's limit of 10 attached databases. */
export const SQLITE_MAX_DATABASES = 11;

export function getDbConfigFromEnv(): IConnectionConfig | null {
  const rawType = process.env.DB_TYPE?.trim().toLowerCase();

  if (!rawType) {
    return null;
  }

  if (!SUPPORTED_DB_TYPES.includes(rawType as DatabaseType)) {
    throw new Error(
      `Invalid DB_TYPE "${rawType}". Supported types: ${SUPPORTED_DB_TYPES.join(', ')}.`
    );
  }

  const type = rawType as DatabaseType;

  if (type === 'sqlite') {
    // Comma-separated list of database files: the first is the main database
    // (unqualified table names resolve there), the rest are attached read-only.
    const raw = process.env.DB_SQLITE_PATH?.trim() || process.env.DB_DATABASE?.trim();
    const paths = parseSqlitePathList(raw);
    const config: IConnectionConfig = {
      type,
      host: 'localhost',
      port: 0,
      database: paths[0],
      connectionTimeout: readTimeout(),
    };
    if (paths.length > 1) {
      config.attach = paths.slice(1);
    }
    return config;
  }

  const baseConfig: IConnectionConfig = {
    type,
    host: process.env.DB_HOST?.trim() || 'localhost',
    port: readPort(3306),
    database: process.env.DB_DATABASE?.trim() || '',
    username: process.env.DB_USER?.trim() || process.env.DB_USERNAME?.trim(),
    password: process.env.DB_PASSWORD,
    connectionTimeout: readTimeout(),
  };

  validateBaseConfig(baseConfig);

  return baseConfig;
}

function parseSqlitePathList(raw: string | undefined): string[] {
  const paths = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (paths.length === 0) {
    throw new Error(
      'Missing required SQLite configuration: set DB_SQLITE_PATH to a comma-separated ' +
      'list of existing database files (first entry = main database).'
    );
  }

  if (paths.length > SQLITE_MAX_DATABASES) {
    throw new Error(
      `Too many SQLite databases: DB_SQLITE_PATH lists ${paths.length} entries, maximum is ` +
      `${SQLITE_MAX_DATABASES} (1 main + 10 attached).\nEntries:\n  ${paths.join('\n  ')}`
    );
  }

  return paths;
}

function readPort(defaultPort: number): number {
  const raw = process.env.DB_PORT?.trim();
  if (!raw) return defaultPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid DB_PORT "${raw}". Must be an integer between 1 and 65535.`);
  }
  return port;
}

function readTimeout(): number {
  const raw = process.env.DB_CONNECTION_TIMEOUT_MS?.trim();
  if (!raw) return 10000;
  const timeout = Number(raw);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`Invalid DB_CONNECTION_TIMEOUT_MS "${raw}". Must be a positive number.`);
  }
  return timeout;
}

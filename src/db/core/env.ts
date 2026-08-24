import type { DatabaseType, IConnectionConfig } from '../interface/index.js';
import { validateBaseConfig } from '../interface/connection.js';

export const SUPPORTED_DB_TYPES: readonly DatabaseType[] = ['mysql', 'sqlite'];

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
    const file = process.env.DB_SQLITE_PATH?.trim() || process.env.DB_DATABASE?.trim();
    if (!file) {
      throw new Error(
        'Missing required SQLite configuration: set DB_SQLITE_PATH to an existing database file.'
      );
    }
    return {
      type,
      host: 'localhost',
      port: 0,
      database: file,
      connectionTimeout: readTimeout(),
    };
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

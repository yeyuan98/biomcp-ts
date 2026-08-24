import type * as mysql from 'mysql2/promise';
import type { IConnectionConfig } from '../../interface/index.js';

export interface MysqlPoolOptions extends mysql.PoolOptions {
  namedPlaceholders: boolean;
}

export function createPoolConfig(config: IConnectionConfig): MysqlPoolOptions {
  return {
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    charset: (config.options?.charset as string) || 'utf8mb4',
    connectTimeout: config.connectionTimeout || 10000,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    namedPlaceholders: true,
  };
}

export function validateMysqlConfig(config: IConnectionConfig): void {
  const missing: string[] = [];

  if (!config.username) missing.push('DB_USER (or DB_USERNAME)');
  if (!config.database) missing.push('DB_DATABASE');

  if (missing.length > 0) {
    throw new Error(
      `Missing required MySQL configuration: ${missing.join(', ')}.\n` +
      `Set these environment variables to enable the MySQL backend.`
    );
  }

  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid MySQL port: ${config.port}. Must be between 1 and 65535.`);
  }
}

export type DatabaseType = 'mysql' | 'sqlite';

export interface IConnectionConfig {
  type: DatabaseType;
  host: string;
  port: number;
  database: string;
  /** SQLite only: additional database files to ATTACH read-only after `database`
   * (the main file). Attached databases are addressable as `alias.table`. */
  attach?: string[];
  username?: string;
  password?: string;
  connectionTimeout?: number;
  options?: Record<string, unknown>;
}

export interface IConnectionPool {
  getConnection(): Promise<IConnection>;
  end(): Promise<void>;
  isHealthy(): boolean;
}

export interface IConnection {
  isConnected(): boolean;
  close(): Promise<void>;
}

export function validateBaseConfig(config: IConnectionConfig): void {
  const missing: string[] = [];

  if (!config.database) missing.push('DB_DATABASE');

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }

  if (config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port number: ${config.port}. Must be between 1 and 65535.`);
  }
}

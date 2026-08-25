import type { IDatabaseBackend, IConnectionConfig, BackendType } from '../interface/index.js';
import { MysqlBackend } from './mysql/backend.js';
import { SqliteBackend } from './sqlite/backend.js';

type BackendFactory = (config: IConnectionConfig) => IDatabaseBackend;

const backendRegistry: Map<BackendType, BackendFactory> = new Map();

export function registerBackend(type: BackendType, factory: BackendFactory): void {
  backendRegistry.set(type, factory);
}

export function createBackend(config: IConnectionConfig): IDatabaseBackend {
  const factory = backendRegistry.get(config.type);

  if (!factory) {
    throw new Error(
      `Unsupported backend type: ${config.type}. Supported types: ${getSupportedTypes().join(', ')}`
    );
  }

  return factory(config);
}

export function getSupportedTypes(): BackendType[] {
  return Array.from(backendRegistry.keys());
}

export function isBackendSupported(type: string): type is BackendType {
  return backendRegistry.has(type as BackendType);
}

registerBackend('mysql', (config) => new MysqlBackend(config));
registerBackend('sqlite', (config) => new SqliteBackend(config));

let defaultBackend: IDatabaseBackend | null = null;

export function getBackend(config?: IConnectionConfig): IDatabaseBackend {
  if (!config) {
    if (!defaultBackend) {
      throw new Error('No backend initialized. Call initializeBackend() first or provide config.');
    }
    return defaultBackend;
  }

  return createBackend(config);
}

export async function initializeBackend(config: IConnectionConfig): Promise<IDatabaseBackend> {
  if (defaultBackend) {
    await defaultBackend.disconnect();
  }

  const backend = createBackend(config);
  try {
    await backend.connect();
  } catch (error) {
    // Never leave a half-initialized backend as the process-wide default —
    // a failed config must not poison subsequent tool calls.
    await backend.disconnect().catch(() => undefined);
    throw error;
  }
  defaultBackend = backend;

  return backend;
}

export async function closeBackend(): Promise<void> {
  if (defaultBackend) {
    await defaultBackend.disconnect();
    defaultBackend = null;
  }
}

export function getDefaultBackend(): IDatabaseBackend | null {
  return defaultBackend;
}

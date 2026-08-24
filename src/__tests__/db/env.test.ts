import { getDbConfigFromEnv } from '../../db/core/env.js';

const ORIGINAL_ENV = { ...process.env };

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DB_')) delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('DB_')) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
  }
}

describe('getDbConfigFromEnv', () => {
  it('returns null when DB_TYPE is unset', () => {
    withEnv({}, () => {
      expect(getDbConfigFromEnv()).toBeNull();
    });
  });

  it('throws on unsupported DB_TYPE (e.g. mongodb)', () => {
    withEnv({ DB_TYPE: 'mongodb' }, () => {
      expect(() => getDbConfigFromEnv()).toThrow(/Invalid DB_TYPE/);
    });
  });

  it('builds mysql config with defaults and env aliases', () => {
    withEnv({ DB_TYPE: 'mysql', DB_USER: 'u1' }, () => {
      expect(() => getDbConfigFromEnv()).toThrow(/DB_DATABASE/);
    });
    withEnv({ DB_TYPE: 'MYSQL', DB_HOST: 'h', DB_PORT: '3307', DB_USERNAME: 'u', DB_PASSWORD: 'p', DB_DATABASE: 'bio' }, () => {
      expect(getDbConfigFromEnv()).toEqual({
        type: 'mysql',
        host: 'h',
        port: 3307,
        database: 'bio',
        username: 'u',
        password: 'p',
        connectionTimeout: 10000,
      });
    });
  });

  it('rejects invalid DB_PORT', () => {
    withEnv({ DB_TYPE: 'mysql', DB_PORT: '99999', DB_DATABASE: 'bio', DB_USER: 'u' }, () => {
      expect(() => getDbConfigFromEnv()).toThrow(/Invalid DB_PORT/);
    });
  });

  it('builds sqlite config from DB_SQLITE_PATH', () => {
    withEnv({ DB_TYPE: 'sqlite', DB_SQLITE_PATH: '/tmp/bio.db' }, () => {
      const cfg = getDbConfigFromEnv();
      expect(cfg?.type).toBe('sqlite');
      expect(cfg?.database).toBe('/tmp/bio.db');
    });
  });

  it('falls back to DB_DATABASE as sqlite file path', () => {
    withEnv({ DB_TYPE: 'sqlite', DB_DATABASE: '/data/fallback.db' }, () => {
      expect(getDbConfigFromEnv()?.database).toBe('/data/fallback.db');
    });
  });

  it('throws when sqlite path missing', () => {
    withEnv({ DB_TYPE: 'sqlite' }, () => {
      expect(() => getDbConfigFromEnv()).toThrow(/DB_SQLITE_PATH/);
    });
  });
});

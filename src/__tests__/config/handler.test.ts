import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAndApplyToEnv,
  getStatus,
  setParameters,
  resetParameters,
  resetLoaderStateForTests,
  featureRunningNow,
  cwdRefusal,
} from '../../config/handler.js';
import { FILE_PARAM_ROWS, ENV_PARAM_ROWS, FEATURE_GROUPS, isFileParamId } from '../../config/parameters.js';
import { configFilePath } from '../../config/store.js';

let dir: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED_VARS = [
  'DB_TYPE', 'DB_SQLITE_PATH', 'DB_DATABASE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_USERNAME', 'DB_PASSWORD', 'DB_CONNECTION_TIMEOUT_MS',
  'ANALYSIS_R', 'ANALYSIS_R_TIMEOUT_MS', 'ANALYSIS_R_MEM_LIMIT_MB', 'ANALYSIS_R_ASSET_TIMEOUT_MS', 'ANALYSIS_R_MIRROR_URL', 'ANALYSIS_R_GITHUB_REPO',
  'ANALYSIS_BIOWASM', 'ANALYSIS_BIOWASM_TIMEOUT_MS', 'ANALYSIS_BIOWASM_MAX_RUN_MS', 'ANALYSIS_BIOWASM_MEM_LIMIT_MB', 'ANALYSIS_BIOWASM_WORKERS', 'ANALYSIS_BIOWASM_MIRROR_URL',
  'BIOMCP_PROJECT_CONFIG',
];

function freshEnv(): NodeJS.ProcessEnv {
  return {};
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'biomcp-config-handler-'));
  for (const v of TRACKED_VARS) {
    SAVED_ENV[v] = process.env[v];
    delete process.env[v];
  }
  resetLoaderStateForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const v of TRACKED_VARS) {
    if (SAVED_ENV[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED_ENV[v];
  }
  resetLoaderStateForTests();
});

function writeConfig(doc: unknown): void {
  writeFileSync(configFilePath(dir), typeof doc === 'string' ? doc : JSON.stringify(doc));
}

describe('registry completeness (drift guards)', () => {
  it('every documented ENV-VARS.md variable is represented in the registry', () => {
    const doc = readFileSync(join(process.cwd(), 'docs/ENV-VARS.md'), 'utf8');
    const tables = doc.split('## Test-only')[0];
    const vars = new Set<string>();
    for (const m of tables.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      vars.add(m[1]);
    }
    const known = new Set<string>();
    for (const row of FILE_PARAM_ROWS) {
      known.add(row.envVar);
      for (const a of row.envVarAliases ?? []) known.add(a);
    }
    for (const row of ENV_PARAM_ROWS) known.add(row.id);
    // proxy lowercase variants documented as HTTPS_PROXY/https_proxy pairs
    known.add('https_proxy'); known.add('http_proxy'); known.add('no_proxy');
    const missing = [...vars].filter((v) => !known.has(v));
    expect(missing).toEqual([]);
  });

  it('registry constraints mirror src/db/core/env.ts (DB_PORT range, sqlite max 11, positive timeout)', async () => {
    const port = FILE_PARAM_ROWS.find((r) => r.id === 'features.database.port');
    expect(port?.schema.safeParse(99999).success).toBe(false);
    expect(port?.schema.safeParse(3306).success).toBe(true);
    const timeout = FILE_PARAM_ROWS.find((r) => r.id === 'features.database.connection_timeout_ms');
    expect(timeout?.schema.safeParse(0).success).toBe(false);
    expect(timeout?.schema.safeParse(-5).success).toBe(false);
    expect(timeout?.schema.safeParse(1000).success).toBe(true);
    const manyPaths = Array.from({ length: 12 }, (_, i) => `db${i}.sqlite`);
    const result = await setParameters(
      { 'features.database.enabled': true, 'features.database.type': 'sqlite', 'features.database.sqlite_path': manyPaths },
      { dir, confirmSensitive: true }
    );
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors.some((e) => e.message.includes('maximum is 11'))).toBe(true);
  });

  it('file param ids are the closed set; every row id round-trips through isFileParamId', () => {
    for (const row of FILE_PARAM_ROWS) expect(isFileParamId(row.id)).toBe(true);
    expect(isFileParamId('ONCOKB_TOKEN')).toBe(false);
    expect(isFileParamId('features.database.sqlite_path.0')).toBe(false);
    expect(isFileParamId('features.database.enabled.x')).toBe(false);
    expect(isFileParamId('$schema')).toBe(false);
  });
});

describe('loadAndApplyToEnv', () => {
  it('is a no-op when the file is missing', () => {
    const env = freshEnv();
    const snap = loadAndApplyToEnv(dir, env);
    expect(snap.filePresent).toBe(false);
    expect(snap.appliedKeys).toEqual([]);
    expect(env['DB_TYPE']).toBeUndefined();
  });

  it('fills unset env vars from an enabled file (env wins)', () => {
    writeConfig({ features: { analysis_r: { enabled: true, timeout_ms: 123456 }, analysis_biowasm: { enabled: true } } });
    const env: NodeJS.ProcessEnv = { ANALYSIS_R: '0' };
    const snap = loadAndApplyToEnv(dir, env);
    expect(env['ANALYSIS_R']).toBe('0'); // env veto preserved
    expect(env['ANALYSIS_R_TIMEOUT_MS']).toBe('123456'); // knob still applied
    expect(env['ANALYSIS_BIOWASM']).toBe('1');
    expect(snap.appliedKeys).toEqual(expect.arrayContaining(['ANALYSIS_R_TIMEOUT_MS', 'ANALYSIS_BIOWASM']));
  });

  it('never overwrites env vars that are already set (aliases included)', () => {
    writeConfig({ features: { database: { enabled: true, type: 'mysql', host: 'file-host', user: 'file-user', database: 'bio' } } });
    const env: NodeJS.ProcessEnv = { DB_HOST: 'env-host', DB_USERNAME: 'alias-user' };
    loadAndApplyToEnv(dir, env);
    expect(env['DB_HOST']).toBe('env-host');
    expect(env['DB_USER']).toBeUndefined(); // alias DB_USERNAME set → file user not applied
    expect(env['DB_TYPE']).toBe('mysql');
  });

  it('enabled:false sections apply nothing', () => {
    writeConfig({ features: { analysis_r: { enabled: false, timeout_ms: 999 } } });
    const env = freshEnv();
    loadAndApplyToEnv(dir, env);
    expect(env['ANALYSIS_R']).toBeUndefined();
    expect(env['ANALYSIS_R_TIMEOUT_MS']).toBeUndefined();
  });

  it('anchors relative sqlite paths against the config dir', () => {
    writeConfig({ features: { database: { enabled: true, type: 'sqlite', sqlite_path: ['data/a.db', '/abs/b.db'] } } });
    const env = freshEnv();
    loadAndApplyToEnv(dir, env);
    const paths = env['DB_SQLITE_PATH']?.split(',');
    expect(paths?.[0]).toBe(join(dir, 'data/a.db'));
    expect(paths?.[1]).toBe('/abs/b.db');
  });

  it('ignores malformed JSON (fail-open) and records the reason', () => {
    writeConfig('{oops');
    const env = freshEnv();
    const snap = loadAndApplyToEnv(dir, env);
    expect(snap.filePresent).toBe(true);
    expect(snap.ignoredReason).toMatch(/invalid JSON|parse/i);
    expect(snap.appliedKeys).toEqual([]);
  });

  it('ignores the whole file on unknown keys under features.* (strict schema)', () => {
    writeConfig({ features: { analysis_biowasm: { enabled: true, data_dir: '/etc' } } });
    const env = freshEnv();
    const snap = loadAndApplyToEnv(dir, env);
    expect(snap.ignoredReason).toBeDefined();
    expect(env['ANALYSIS_BIOWASM']).toBeUndefined(); // escalation structurally impossible
  });

  it('ignores files with unknown feature sections', () => {
    writeConfig({ features: { mystery: { enabled: true } } });
    const snap = loadAndApplyToEnv(dir, freshEnv());
    expect(snap.ignoredReason).toMatch(/unknown feature/i);
  });

  it('rejects prototype-pollution keys', () => {
    writeConfig('{"features":{"analysis_r":{"enabled":true}},"__proto__":{"x":1}}');
    const env = freshEnv();
    const snap = loadAndApplyToEnv(dir, env);
    expect(snap.ignoredReason).toMatch(/prototype-pollution/);
  });

  it('honors the kill switch', () => {
    writeConfig({ features: { analysis_r: { enabled: true } } });
    const env: NodeJS.ProcessEnv = { BIOMCP_PROJECT_CONFIG: '0' };
    const snap = loadAndApplyToEnv(dir, env);
    expect(snap.killSwitchActive).toBe(true);
    expect(env['ANALYSIS_R']).toBeUndefined();
  });
});

describe('setParameters', () => {
  it('writes an enable patch atomically and reports the diff', async () => {
    const result = await setParameters(
      { 'features.analysis_biowasm.enabled': true, 'features.analysis_biowasm.workers': 2 },
      { dir }
    );
    expect(result.validation.ok).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.changes.map((c) => c.key).sort()).toEqual(['features.analysis_biowasm.enabled', 'features.analysis_biowasm.workers']);
    const doc = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    expect(doc.features.analysis_biowasm).toEqual({ enabled: true, workers: 2 });
  });

  it('applies nothing when any key is invalid (atomic batch)', async () => {
    const result = await setParameters(
      { 'features.analysis_r.enabled': true, 'features.analysis_r.timeout_ms': -1 },
      { dir }
    );
    expect(result.validation.ok).toBe(false);
    expect(result.wrote).toBe(false);
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('rejects unknown keys with a closest-match suggestion', async () => {
    const result = await setParameters({ 'features.analysis_r.enbled': true }, { dir });
    expect(result.validation.ok).toBe(false);
    const err = result.validation.errors[0];
    expect(err.code).toBe('unknown-key');
    expect(err.suggestion).toBe('features.analysis_r.enabled');
  });

  it('rejects env-only parameters as read-only with how-to-set guidance', async () => {
    const result = await setParameters({ ONCOKB_TOKEN: 'sekrit' }, { dir });
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors[0].code).toBe('read-only');
    expect(result.validation.errors[0].how_to_set).toMatch(/client env block/);
  });

  it('requires confirm_sensitive for sensitive keys', async () => {
    const values = { 'features.database.enabled': true, 'features.database.type': 'sqlite', 'features.database.sqlite_path': 'a.db' };
    const refused = await setParameters(values, { dir });
    expect(refused.validation.ok).toBe(false);
    expect(refused.validation.errors[0].code).toBe('confirm-required');
    const allowed = await setParameters(values, { dir, confirmSensitive: true });
    expect(allowed.validation.ok).toBe(true);
  });

  it('null removes a key and empty sections disappear', async () => {
    await setParameters({ 'features.analysis_r.enabled': true, 'features.analysis_r.timeout_ms': 5000 }, { dir });
    const result = await setParameters({ 'features.analysis_r.enabled': null, 'features.analysis_r.timeout_ms': null }, { dir });
    expect(result.validation.ok).toBe(true);
    const doc = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    expect(doc.features).toBeUndefined();
  });

  it('dry_run validates and diffs without writing', async () => {
    const result = await setParameters({ 'features.analysis_biowasm.enabled': true }, { dir, dryRun: true });
    expect(result.validation.ok).toBe(true);
    expect(result.wrote).toBe(false);
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('group validation enforces type-conditional requirements', async () => {
    const missing = await setParameters({ 'features.database.enabled': true, 'features.database.type': 'mysql' }, { dir, confirmSensitive: true });
    expect(missing.validation.ok).toBe(false);
    expect(missing.validation.errors.some((e) => e.message.includes('features.database.user'))).toBe(true);

    const noType = await setParameters({ 'features.database.enabled': true }, { dir });
    expect(noType.validation.ok).toBe(false);
    expect(noType.validation.errors.some((e) => e.message.includes('type'))).toBe(true);
  });

  it('repairs an invalid JSON file instead of merging into garbage', async () => {
    writeConfig('not json at all');
    const result = await setParameters({ 'features.analysis_r.enabled': true }, { dir });
    expect(result.validation.ok).toBe(true);
    expect(result.repaired_note).toMatch(/invalid/i);
    const doc = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    expect(doc.features.analysis_r.enabled).toBe(true);
  });

  it('redacts secrets in the change diff', async () => {
    const result = await setParameters({ 'features.database.password': 'hunter2' }, { dir, confirmSensitive: true });
    expect(result.validation.ok).toBe(true);
    const change = result.changes.find((c) => c.key === 'features.database.password');
    expect(change?.new).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('rejects reserved key segments', async () => {
    const result = await setParameters({ 'features.__proto__.enabled': true }, { dir });
    expect(result.validation.ok).toBe(false);
  });

  it('rejects an empty values map', async () => {
    const result = await setParameters({}, { dir });
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors[0].message).toMatch(/at least one value/);
  });

  it('repairs a non-object features value with a note', async () => {
    writeConfig('{"features": 42}');
    const result = await setParameters({ 'features.analysis_r.enabled': true }, { dir });
    expect(result.validation.ok).toBe(true);
    expect(result.repaired_note).toMatch(/non-object "features"/);
  });

  it('does not suggest a closest match for absurdly long keys', async () => {
    const longKey = 'features.'.concat('x'.repeat(200));
    const result = await setParameters({ [longKey]: true }, { dir });
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors[0].suggestion).toBeUndefined();
  });
});

describe('resetParameters', () => {
  it('removes a whole feature section (confirm required when sensitive keys present)', async () => {
    await setParameters(
      { 'features.database.enabled': true, 'features.database.type': 'sqlite', 'features.database.sqlite_path': 'a.db', 'features.database.password': 'x' },
      { dir, confirmSensitive: true }
    );
    const refused = await resetParameters({ feature: 'database' }, { dir });
    expect(refused.validation.ok).toBe(false);
    expect(refused.validation.errors[0].code).toBe('confirm-required');

    const done = await resetParameters({ feature: 'database' }, { dir, confirmSensitive: true });
    expect(done.validation.ok).toBe(true);
    const doc = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    expect(doc.features?.database).toBeUndefined();
  });

  it('removes individual keys', async () => {
    await setParameters({ 'features.analysis_r.enabled': true, 'features.analysis_r.timeout_ms': 1000 }, { dir });
    const done = await resetParameters({ keys: ['features.analysis_r.timeout_ms'] }, { dir });
    expect(done.validation.ok).toBe(true);
    const doc = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    expect(doc.features.analysis_r).toEqual({ enabled: true });
  });

  it('rejects unknown features', async () => {
    const result = await resetParameters({ feature: 'teleportation' }, { dir });
    expect(result.validation.ok).toBe(false);
  });
});

describe('getStatus', () => {
  it('reports per-feature running state and pending restart after a file enable', () => {
    writeConfig({ features: { analysis_r: { enabled: true } } });
    loadAndApplyToEnv(dir, process.env); // gates read process.env — the runtime substrate
    const status = getStatus({ dir, env: process.env });
    const features = status['features'] as { id: string; running_now: boolean; pending_restart: boolean; source: string }[];
    const r = features.find((f) => f.id === 'analysis_r')!;
    expect(r.running_now).toBe(true);
    expect(r.pending_restart).toBe(false);
    expect(r.source).toContain('config-file');
  });

  it('flags pending_restart when the file enables a feature the env disables', () => {
    writeConfig({ features: { analysis_r: { enabled: true } } });
    process.env.ANALYSIS_R = '0';
    const status = getStatus({ dir, env: process.env });
    const features = status['features'] as { id: string; running_now: boolean; pending_restart: boolean; source: string }[];
    const r = features.find((f) => f.id === 'analysis_r')!;
    expect(r.running_now).toBe(false);
    expect(r.pending_restart).toBe(true);
    expect(r.source).toBe('disabled by env veto');
    const conflicts = status['conflicts'] as { type: string }[];
    expect(conflicts.some((c) => c.type === 'env-veto')).toBe(true);
  });

  it('file-enabled feature with NO disabling env var is "file (pending restart)", never a false veto label', () => {
    writeConfig({ features: { analysis_biowasm: { enabled: true } } });
    const status = getStatus({ dir, env: process.env });
    const features = status['features'] as { id: string; source: string; running_now: boolean }[];
    const r = features.find((f) => f.id === 'analysis_biowasm')!;
    expect(r.running_now).toBe(false);
    expect(r.source).toBe('file (pending restart)');
    const conflicts = status['conflicts'] as { type: string }[];
    expect(conflicts.some((c) => c.type === 'env-veto')).toBe(false);
  });

  it('masks env-kind values: presence + fingerprint only, never the value', () => {
    const status = getStatus({ dir, env: { ONCOKB_TOKEN: 'super-secret-token-value' }, filter: 'env' });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('super-secret-token-value');
    const catalog = status['catalog'] as Record<string, unknown>[];
    const row = catalog.find((r) => r['id'] === 'ONCOKB_TOKEN');
    expect(row?.['set']).toBe(true);
    expect(String(row?.['fingerprint'])).toMatch(/^len:\d+,sha256:[0-9a-f]{8}$/);
  });

  it('masks env-sourced sensitive file params and always masks secrets', () => {
    const status = getStatus({ dir, env: { DB_HOST: 'internal-db.corp', DB_PASSWORD: 'pw' } });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('internal-db.corp');
    expect(serialized).not.toContain('"pw"');
  });

  it('surfaces invalid env values as conflicts', () => {
    const status = getStatus({ dir, env: { DB_TYPE: 'mysql', DB_PORT: '99999' } });
    const conflicts = status['conflicts'] as { type: string; key?: string }[];
    expect(conflicts.some((c) => c.type === 'invalid-env' && c.key === 'features.database.port')).toBe(true);
  });

  it('treats empty-string env values as unset (no spurious invalid-env)', () => {
    const status = getStatus({ dir, env: { DB_TYPE: 'mysql', DB_PORT: '' } });
    const conflicts = status['conflicts'] as { type: string; key?: string }[];
    expect(conflicts.some((c) => c.type === 'invalid-env' && c.key === 'features.database.port')).toBe(false);
  });

  it('masks the sqlite Entries listing from env-parse-error conflicts', () => {
    const secretPath = '/secret/lab/s0.db';
    const paths = [secretPath, ...Array.from({ length: 13 }, (_, i) => `s${i}.db`)].join(',');
    process.env.DB_TYPE = 'sqlite';
    process.env.DB_SQLITE_PATH = paths;
    const status = getStatus({ dir, env: process.env });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(secretPath);
    const conflicts = status['conflicts'] as { type: string; detail?: string }[];
    const parse = conflicts.find((c) => c.type === 'env-parse-error');
    expect(parse).toBeDefined();
    expect(parse!.detail).not.toContain('Entries');
  });

  it('surfaces the loader fail-open reason for a broken file', () => {
    writeConfig('{bad');
    loadAndApplyToEnv(dir, freshEnv());
    const status = getStatus({ dir, env: freshEnv() });
    const health = status['config_health'] as Record<string, unknown>;
    expect(String(health['startup_ignored_reason'])).toMatch(/JSON/i);
    const conflicts = status['conflicts'] as { type: string }[];
    expect(conflicts.some((c) => c.type === 'config-file-ignored')).toBe(true);
  });

  it('filter scopes the detailed catalog', () => {
    const status = getStatus({ dir, env: freshEnv(), filter: 'features.analysis_r' });
    const catalog = status['catalog'] as Record<string, unknown>[];
    expect(catalog.length).toBe(FEATURE_GROUPS.find((g) => g.id === 'analysis_r')!.rows.length);
    for (const row of catalog) expect(row['effect']).toBeDefined();
  });

  it('degrades gracefully when the loader never ran (harness scenario)', () => {
    const status = getStatus({ dir, env: freshEnv() });
    const health = status['config_health'] as Record<string, unknown>;
    expect(health['loaded_at_startup']).toBe(false);
    expect(health['note']).toMatch(/tests\/library/);
  });
});

describe('cwdRefusal', () => {
  it('refuses the filesystem root and the home directory with an env-block translation', () => {
    const refusal = cwdRefusal(
      {
        'features.analysis_r.enabled': true,
        'features.database.enabled': true,
        'features.database.type': 'sqlite',
        'features.database.sqlite_path': 'a.db',
        'features.database.password': 'hunter2',
      },
      '/'
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.env_block).toEqual({
      ANALYSIS_R: '1',
      DB_TYPE: 'sqlite', // trigger row translated with sibling semantics, never "true"
      DB_SQLITE_PATH: 'a.db',
      DB_PASSWORD: '<set-here>', // secrets are never echoed
    });
    expect(refusal!.hints.some((h) => h.includes('mcp_servers.biomcp.env'))).toBe(true);
    const serialized = JSON.stringify(refusal);
    expect(serialized).not.toContain('hunter2');
  });

  it('omits the database trigger from the env block when the type is absent', () => {
    const refusal = cwdRefusal({ 'features.database.enabled': true }, '/');
    expect(refusal!.env_block).toEqual({});
  });

  it('returns null for a normal writable project cwd', () => {
    expect(cwdRefusal({ 'features.analysis_r.enabled': true }, dir)).toBeNull();
  });
});

describe('featureRunningNow', () => {
  it('delegates to the real gate functions', () => {
    const savedR = process.env.ANALYSIS_R;
    process.env.ANALYSIS_R = '1';
    expect(featureRunningNow('analysis_r')).toBe(true);
    process.env.ANALYSIS_R = '0';
    expect(featureRunningNow('analysis_r')).toBe(false);
    process.env.ANALYSIS_R = 'false';
    expect(featureRunningNow('analysis_r')).toBe(false);
    if (savedR === undefined) delete process.env.ANALYSIS_R;
    else process.env.ANALYSIS_R = savedR;
  });
});

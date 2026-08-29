import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FILE_MAX_BYTES,
  CONFIG_FILE_NAME,
  configFilePath,
  readConfigFile,
  writeConfigFile,
} from '../../config/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'biomcp-config-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('config store', () => {
  it('writeConfigFile creates a pretty-printed file with mode 0600 and no temp leftovers', () => {
    writeConfigFile(dir, { features: { analysis_r: { enabled: true } } });
    const path = configFilePath(dir);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('"features"');
    expect(raw).toContain('"enabled": true');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writeConfigFile preserves unknown top-level keys across read-modify-write', () => {
    writeConfigFile(dir, { $schema: 'https://example.com/x', customTop: { keep: true }, features: { analysis_r: { enabled: false } } });
    const read = readConfigFile(dir);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    const doc = { ...read.doc, features: { analysis_r: { enabled: true } } };
    writeConfigFile(dir, doc);
    const round = readConfigFile(dir);
    expect(round.status).toBe('ok');
    if (round.status !== 'ok') return;
    expect(round.doc['$schema']).toBe('https://example.com/x');
    expect((round.doc['customTop'] as Record<string, unknown>)['keep']).toBe(true);
    expect((round.doc['features'] as Record<string, unknown>)['analysis_r']).toEqual({ enabled: true });
  });

  it('readConfigFile reports missing when the file is absent', () => {
    expect(readConfigFile(dir).status).toBe('missing');
  });

  it('readConfigFile refuses a symlinked config file', () => {
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    symlinkSync(real, configFilePath(dir));
    const read = readConfigFile(dir);
    expect(read.status).toBe('error');
    if (read.status === 'error') expect(read.error.code).toBe('symlink');
  });

  it('readConfigFile refuses files over the size cap', () => {
    writeFileSync(configFilePath(dir), '{"pad":"' + 'x'.repeat(CONFIG_FILE_MAX_BYTES) + '"}');
    const read = readConfigFile(dir);
    expect(read.status).toBe('error');
    if (read.status === 'error') expect(read.error.code).toBe('too-large');
  });

  it('readConfigFile rejects invalid JSON and non-object top level as unreadable', () => {
    writeFileSync(configFilePath(dir), '{not json');
    const read = readConfigFile(dir);
    expect(read.status).toBe('error');
    if (read.status === 'error') expect(read.error.code).toBe('unreadable');

    writeFileSync(configFilePath(dir), '[1,2,3]');
    const arr = readConfigFile(dir);
    expect(arr.status).toBe('error');
    if (arr.status === 'error') expect(arr.error.code).toBe('unreadable');
  });

  it('appends the git exclude advisory once, only inside a git repo, on first create', () => {
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeConfigFile(dir, { features: {} });
    const exclude = join(dir, '.git', 'info', 'exclude');
    expect(existsSync(exclude)).toBe(true);
    expect(readFileSync(exclude, 'utf8')).toContain(CONFIG_FILE_NAME);

    writeConfigFile(dir, { features: { analysis_r: { enabled: true } } });
    const after = readFileSync(exclude, 'utf8');
    expect(after.match(new RegExp(CONFIG_FILE_NAME.replace(/\./g, '\\.'), 'g'))?.length).toBe(1);
  });

  it('does not create git artifacts outside a git repo', () => {
    writeConfigFile(dir, { features: {} });
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});

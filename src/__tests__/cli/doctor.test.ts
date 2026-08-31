import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDoctorReport, exitCodeFor, formatDoctorText, nodeVersionOk, REQUIRED_NODE } from '../../cli/doctor.js';
import { resetLoaderStateForTests } from '../../config/handler.js';
import { configFilePath } from '../../config/store.js';
import { ENV_PARAM_ROWS } from '../../config/parameters.js';

let dir: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const TRACKED_VARS = [
  'DB_TYPE', 'DB_USER', 'DB_DATABASE', 'ANALYSIS_R', 'ANALYSIS_BIOWASM', 'ANALYSIS_BIOWASM_DATA_DIR',
  'NCBI_API_KEY', 'ONCOKB_TOKEN', 'BIOMCP_PROJECT_CONFIG',
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'biomcp-cli-doctor-'));
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

describe('nodeVersionOk', () => {
  it('mirrors the engines gate', () => {
    expect(nodeVersionOk('22.13.0')).toBe(true);
    expect(nodeVersionOk('22.12.9')).toBe(false);
    expect(nodeVersionOk('21.99.0')).toBe(false);
    expect(nodeVersionOk('23.0.0')).toBe(true);
    expect(nodeVersionOk('garbage')).toBe(false);
    expect(REQUIRED_NODE).toEqual({ major: 22, minor: 13 });
  });
});

describe('buildDoctorReport', () => {
  it('clean install: ok, no blockers, features off, env presence only', () => {
    process.env['NCBI_API_KEY'] = 'very-secret-value';
    const report = buildDoctorReport(dir);
    expect(report.schema_version).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.node.ok).toBe(true);
    expect(report.mode_advice).toContain('mode:');
    const key = report.env_masked.find((r) => r.id === 'NCBI_API_KEY');
    expect(key?.present).toBe(true);
    expect(JSON.stringify(report)).not.toContain('very-secret-value');
  });

  it('malformed config file -> CONFIG_FILE_IGNORED blocker and exit 1', () => {
    writeFileSync(configFilePath(dir), '{ not json');
    const report = buildDoctorReport(dir);
    expect(report.ok).toBe(false);
    expect(exitCodeFor(report)).toBe(1);
    expect(report.blockers.map((b) => b.code)).toContain('CONFIG_FILE_IGNORED');
    expect(report.startup.ignored_reason).toBeTruthy();
  });

  it('DB_TYPE=mysql via env without user/database -> DB_CONFIG_INCOMPLETE blocker with fix note', () => {
    // (via the config FILE, an incomplete mysql section is rejected by the
    // loader itself -> CONFIG_FILE_IGNORED; the env path is doctor's catch)
    process.env['DB_TYPE'] = 'mysql';
    const report = buildDoctorReport(dir);
    expect(exitCodeFor(report)).toBe(1);
    expect(report.blockers.map((b) => b.code)).toContain('DB_CONFIG_INCOMPLETE');
    expect(report.features.find((f) => f.id === 'database')?.running_after_restart).toBe(true);
  });

  it('env veto over the file surfaces as a CONFIG_CONFLICT blocker', () => {
    writeFileSync(configFilePath(dir), JSON.stringify({ features: { analysis_biowasm: { enabled: true } } }));
    process.env['ANALYSIS_BIOWASM'] = '0';
    const report = buildDoctorReport(dir);
    const conflict = report.blockers.find((b) => b.code === 'CONFIG_CONFLICT');
    expect(conflict?.message).toContain('env-veto');
    expect(exitCodeFor(report)).toBe(1);
  });

  it('valid sqlite config: ok with running_after_restart true', () => {
    writeFileSync(configFilePath(dir), JSON.stringify({ features: { database: { enabled: true, type: 'sqlite', sqlite_path: 'data.db' } } }));
    const report = buildDoctorReport(dir);
    expect(report.ok).toBe(true);
    expect(report.features.find((f) => f.id === 'database')?.running_after_restart).toBe(true);
  });

  it('every ENV_PARAM_ROWS id appears in env_masked (presence only)', () => {
    const report = buildDoctorReport(dir);
    expect(report.env_masked.map((r) => r.id).sort()).toEqual([...ENV_PARAM_ROWS.map((r) => r.id)].sort());
    for (const row of report.env_masked) expect(Object.keys(row).sort()).toEqual(['id', 'present']);
  });

  it('next_steps embed exactly one client snippet when --client is scoped', () => {
    const report = buildDoctorReport(dir, 'codex');
    const joined = report.next_steps.join('\n');
    expect(joined).toContain('[mcp_servers.biomcp]');
    expect(joined).not.toContain('opencode.json');
  });

  it('nothing desired: snippet command is the pinned minimal one-shot, never bare npx', () => {
    const report = buildDoctorReport(dir, 'opencode');
    const joined = report.next_steps.join('\n');
    expect(joined).toContain('"command": [\n        "npx",\n        "-y",\n        "-p",\n        "biomcp@');
    expect(joined).not.toContain('"-p",\n        "webr@');
    expect(joined).not.toContain('"-p",\n        "mysql2@');
    expect(joined).toContain('"timeout": 30000');
  });

  it('R desired via env: snippet includes webr pin and raised timeout 120000', () => {
    process.env['ANALYSIS_R'] = '1';
    const report = buildDoctorReport(dir, 'opencode');
    const joined = report.next_steps.join('\n');
    expect(joined).toContain('-p');
    expect(joined).toContain('webr@');
    expect(joined).toContain('"timeout": 120000');
    expect(joined).not.toContain('mysql2@');
  });

  it('mysql desired via env: snippet includes mysql2 pin, default timeout', () => {
    process.env['DB_TYPE'] = 'mysql';
    process.env['DB_USER'] = 'u';
    process.env['DB_DATABASE'] = 'd';
    const report = buildDoctorReport(dir, 'opencode');
    const joined = report.next_steps.join('\n');
    expect(joined).toContain('mysql2@');
    expect(joined).not.toContain('webr@');
    expect(joined).toContain('"timeout": 30000');
  });

  it('R + mysql desired via FILE (env empty): snippet is the pinned union command with both peers', () => {
    writeFileSync(
      configFilePath(dir),
      JSON.stringify({ features: { analysis_r: { enabled: true }, database: { enabled: true, type: 'mysql', user: 'u', database: 'd' } } })
    );
    const report = buildDoctorReport(dir, 'opencode');
    const joined = report.next_steps.join('\n');
    const webrAt = joined.indexOf('webr@');
    const mysqlAt = joined.indexOf('mysql2@');
    expect(webrAt).toBeGreaterThanOrEqual(0);
    expect(mysqlAt).toBeGreaterThan(webrAt); // frozen canonical order: webr before mysql2
    expect(joined).toContain('"timeout": 120000');
  });

  it('text format renders blockers and fix commands readably', () => {
    writeFileSync(configFilePath(dir), '{ broken');
    const text = formatDoctorText(buildDoctorReport(dir));
    expect(text).toContain('biomcp doctor');
    expect(text).toContain('blocker [CONFIG_FILE_IGNORED]');
  });
});

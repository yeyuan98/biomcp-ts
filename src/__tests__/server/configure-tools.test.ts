import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectToolClient } from '../helpers/mcp-harness.js';
import { registerConfigureTool } from '../../server/tools/configure.js';
import { configFilePath } from '../../config/store.js';

/**
 * Tool-level tests for biomcp_configure over a real McpServer + InMemory
 * transport. Mutations run in a tmp cwd (chdir'd for the duration of the
 * suite and restored afterwards) so file writes are observable.
 */

const SAVED_CWD = process.cwd();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'biomcp-configure-tool-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(SAVED_CWD);
  rmSync(dir, { recursive: true, force: true });
});

async function callConfigure(args: Record<string, unknown>): Promise<{ parsed: any; raw: { isError?: boolean }; text: string }> {
  const server = new McpServer({ name: 'test-configure', version: '1.0.0' });
  registerConfigureTool(server);
  const client = await connectToolClient(server);
  try {
    const result = (await client.callTool('biomcp_configure', args, { raw: true })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    const text = result.content[0]?.text ?? '';
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { parsed, raw: { isError: result.isError }, text };
  } finally {
    await client.close();
  }
}

describe('biomcp_configure tool', () => {
  it('status with no arguments returns the overview: features (with settable_keys), health, server context — catalog omitted', async () => {
    const { parsed, raw } = await callConfigure({});
    expect(raw.isError).toBeFalsy();
    expect(parsed.server_context.install_mode).toBeDefined();
    expect(parsed.config_health.config_path).toBe(configFilePath(dir));
    expect(parsed.features.map((f: any) => f.id).sort()).toEqual(['analysis_biowasm', 'analysis_r', 'database']);
    for (const f of parsed.features as any[]) expect(f.settable_keys).toContain('enabled');
    expect(parsed.counts).toEqual({ file_params: expect.any(Number), env_params: expect.any(Number) });
    expect(parsed.catalog).toBeUndefined();
    expect(String(parsed.catalog_hint)).toContain('filter');
  });

  it('set enables a feature, writes the file, and returns agent/user steps', async () => {
    const { parsed, raw } = await callConfigure({ action: 'set', values: { 'features.analysis_biowasm.enabled': true } });
    expect(raw.isError).toBeFalsy();
    expect(parsed.validation.ok).toBe(true);
    expect(parsed.wrote).toBe(true);
    expect(parsed.agent_steps.some((s: string) => s.includes('running_now === true'))).toBe(true);
    expect(parsed.user_steps.some((s: string) => s.includes('Restart'))).toBe(true);
    const doc = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    expect(doc.features.analysis_biowasm.enabled).toBe(true);
  });

  it('set with an invalid batch writes nothing and returns isError with per-key hints', async () => {
    const { parsed, raw } = await callConfigure({
      action: 'set',
      values: { 'features.analysis_r.enabled': true, 'features.analysis_r.timeout_ms': 'not-a-number' },
    });
    expect(raw.isError).toBe(true);
    expect(parsed.error.code).toBe('validation_failed');
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('set on an env-only parameter is read-only rejected with how-to-set guidance', async () => {
    const { parsed, raw } = await callConfigure({ action: 'set', values: { ANALYSIS_BIOWASM_DATA_DIR: '/etc' } });
    expect(raw.isError).toBe(true);
    expect(parsed.error.code).toBe('validation_failed');
    expect(parsed.text ?? parsed.error.message).toBeTruthy();
    expect(JSON.stringify(parsed)).toContain('query-only');
  });

  it('sensitive keys require confirm_sensitive', async () => {
    const values = { 'features.database.enabled': true, 'features.database.type': 'sqlite', 'features.database.sqlite_path': 'a.db' };
    const refused = await callConfigure({ action: 'set', values });
    expect(refused.raw.isError).toBe(true);
    expect(JSON.stringify(refused.parsed)).toContain('confirm_sensitive=true');
    expect(existsSync(configFilePath(dir))).toBe(false);

    const allowed = await callConfigure({ action: 'set', values, confirm_sensitive: true });
    expect(allowed.raw.isError).toBeFalsy();
    expect(allowed.parsed.validation.ok).toBe(true);
  });

  it('dry_run writes nothing but returns the diff', async () => {
    const { parsed, raw } = await callConfigure({ action: 'set', values: { 'features.analysis_r.enabled': true }, dry_run: true });
    expect(raw.isError).toBeFalsy();
    expect(parsed.wrote).toBe(false);
    expect(parsed.dry_run).toBe(true);
    expect(existsSync(configFilePath(dir))).toBe(false);
  });

  it('reset removes a feature section', async () => {
    await callConfigure({ action: 'set', values: { 'features.analysis_r.enabled': true } });
    const { parsed } = await callConfigure({ action: 'reset', target: 'analysis_r', confirm_sensitive: true });
    expect(parsed.validation.ok).toBe(true);
    const doc = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    expect(doc.features?.analysis_r).toBeUndefined();
  });

  it('status masks env values (presence + fingerprint, never the value)', async () => {
    process.env.ONCOKB_TOKEN = 'tool-level-secret';
    try {
      const { text } = await callConfigure({ action: 'status', filter: 'env' });
      expect(text).not.toContain('tool-level-secret');
      expect(text).toMatch(/len:\d+,sha256:[0-9a-f]{8}/);
    } finally {
      delete process.env.ONCOKB_TOKEN;
    }
  });

  it('status reports the broken-file reason to the agent (machine-reachable fail-open)', async () => {
    writeFileSync(configFilePath(dir), '{broken');
    const { parsed } = await callConfigure({ action: 'status' });
    expect(String(parsed.config_health.file_error)).toMatch(/JSON/i);
  });
});

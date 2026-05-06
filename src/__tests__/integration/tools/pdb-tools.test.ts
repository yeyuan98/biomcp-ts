import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { unlinkSync, existsSync } from 'node:fs';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('pdb search mode', () => {
  it('searches for crambin and returns results with metadata', async () => {
    const results = await harness.callTool('pdb', { query: 'crambin', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pdb_id).toBeTruthy();
    expect(results[0].pdb_id.length).toBe(4);
    expect(results[0].summary).toBeDefined();
    expect(results[0].summary.title).toBeTruthy();
  }, 30000);

  it('returns empty for nonsense query', async () => {
    const results = await harness.callTool('pdb', { query: 'ZZZZNOTAPROTEIN99999', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  }, 30000);

  it('respects limit parameter', async () => {
    const results = await harness.callTool('pdb', { query: 'hemoglobin', limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  }, 30000);
});

describe('pdb get mode', () => {
  it('returns 1CRN metadata', async () => {
    const result = await harness.callTool('pdb', { pdb_id: '1CRN' });
    expect(result.pdb_id).toBe('1CRN');
    expect(result.summary).toBeDefined();
    expect(result.summary.title).toBeTruthy();
    expect(result.summary.experimental_method).toBeTruthy();
  }, 30000);

  it('returns 4HHB with sections', async () => {
    const result = await harness.callTool('pdb', { pdb_id: '4HHB', sections: ['polymer_entities', 'citation'] });
    expect(result.pdb_id).toBe('4HHB');
    expect(result.summary).toBeDefined();
    expect(result.sections).toBeDefined();
    expect(result.sections).toHaveProperty('polymer_entities');
    expect(result.sections).toHaveProperty('citation');
  }, 30000);

  it('rejects invalid PDB ID format', async () => {
    await expect(
      harness.callTool('pdb', { pdb_id: 'INVALID' })
    ).rejects.toThrow();
  }, 30000);

  it('rejects AlphaFold ID', async () => {
    await expect(
      harness.callTool('pdb', { pdb_id: 'AF_AFP68871F1' })
    ).rejects.toThrow();
  }, 30000);
});

describe('pdb download mode', () => {
  it('downloads 1CRN in cif format and returns file path', async () => {
    const result = await harness.callTool('pdb', { pdb_id: '1CRN', download: true, format: 'cif' });
    expect(result.file).toBeDefined();
    expect(result.file.file_path).toBeTruthy();
    expect(result.file.format).toBe('cif');
    expect(result.file.file_size_bytes).toBeGreaterThan(0);
    expect(result.file.file_size_human).toBeTruthy();
    expect(existsSync(result.file.file_path)).toBe(true);

    unlinkSync(result.file.file_path);
    const parentDir = result.file.file_path.substring(0, result.file.file_path.lastIndexOf('/'));
    try { require('node:fs').rmSync(parentDir, { recursive: true }); } catch {}
  }, 30000);

  it('downloads 1CRN in pdb format', async () => {
    const result = await harness.callTool('pdb', { pdb_id: '1CRN', download: true, format: 'pdb' });
    expect(result.file).toBeDefined();
    expect(result.file.format).toBe('pdb');
    expect(existsSync(result.file.file_path)).toBe(true);

    unlinkSync(result.file.file_path);
    const parentDir = result.file.file_path.substring(0, result.file.file_path.lastIndexOf('/'));
    try { require('node:fs').rmSync(parentDir, { recursive: true }); } catch {}
  }, 30000);
});

describe('pdb error handling', () => {
  it('errors when neither query nor pdb_id provided', async () => {
    await expect(
      harness.callTool('pdb', {})
    ).rejects.toThrow();
  }, 30000);
});

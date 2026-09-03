import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';
import { unlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('pdb search mode', () => {
  it('searches for crambin and returns results with metadata', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('pdb', { query: 'crambin', limit: 5 }));
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pdb_id).toBeTruthy();
    expect(results[0].pdb_id.length).toBe(4);
    expect(results[0].summary).toBeDefined();
    expect(results[0].summary.title).toBeTruthy();
  }, 60000);

  it('returns empty for nonsense query', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('pdb', { query: 'ZZZZNOTAPROTEIN99999', limit: 5 }));
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('pdb', { query: 'hemoglobin', limit: 2 }));
    expect(results.length).toBeLessThanOrEqual(2);
  }, 60000);

  it('search results include key metadata fields', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('pdb', { query: 'hemoglobin', limit: 1 }));
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.pdb_id).toBeTruthy();
    expect(r.summary).toBeDefined();
    expect(r.summary.title).toBeTruthy();
    expect(r.summary.experimental_method).toBeTruthy();
    expect(r.summary.resolution).toBeDefined();
    expect(r.summary.deposition_date).toBeDefined();
    expect(r.summary.release_date).toBeDefined();
  }, 60000);
});

describe('pdb get mode', () => {
  it('returns 1CRN metadata', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN' }));
    expect(result.pdb_id).toBe('1CRN');
    expect(result.summary).toBeDefined();
    expect(result.summary.title).toBeTruthy();
    // Stable identity: 1CRN is crambin (Teeter & Hendrickson).
    expect(result.summary.title).toMatch(/crambin/i);
    expect(result.summary.experimental_method).toBeTruthy();
  }, 60000);

  it('returns 4HHB with specific sections', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '4HHB', sections: ['polymer_entities', 'experiment'] }));
    expect(result.pdb_id).toBe('4HHB');
    expect(result.summary).toBeDefined();
    expect(result.sections).toBeDefined();
    expect(result.sections).toHaveProperty('polymer_entities');
    expect(result.sections).toHaveProperty('experiment');
    expect(result.sections.polymer_entities.length).toBeGreaterThan(0);
    expect(result.sections.experiment.methods).toBeDefined();
  }, 60000);

  it('returns 1CRN with all sections', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', sections: ['all'] }));
    expect(result.pdb_id).toBe('1CRN');
    expect(result.summary).toBeDefined();
    expect(result.sections).toBeDefined();
    expect(result.sections).toHaveProperty('polymer_entities');
    expect(result.sections).toHaveProperty('ligands');
    expect(result.sections).toHaveProperty('assembly');
    expect(result.sections).toHaveProperty('experiment');
    expect(result.sections).toHaveProperty('citation');
  }, 60000);

  it('polymer_entities section returns array with entity data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '4HHB', sections: ['polymer_entities'] }));
    const entities = result.sections.polymer_entities;
    expect(Array.isArray(entities)).toBe(true);
    expect(entities.length).toBeGreaterThan(0);
    for (const entity of entities) {
      expect(entity).toBeDefined();
      expect(entity._error).toBeUndefined();
    }
  }, 60000);

  it('ligands section returns array for entries with ligands', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '4HHB', sections: ['ligands'] }));
    const ligands = result.sections.ligands;
    expect(Array.isArray(ligands)).toBe(true);
    expect(ligands.length).toBeGreaterThan(0);
    for (const lig of ligands) {
      expect(lig._error).toBeUndefined();
    }
  }, 60000);

  it('ligands section returns empty array for entries without ligands', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', sections: ['ligands'] }));
    const ligands = result.sections.ligands;
    expect(Array.isArray(ligands)).toBe(true);
    expect(ligands.length).toBe(0);
  }, 60000);

  it('assembly section returns array with assembly data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', sections: ['assembly'] }));
    const assemblies = result.sections.assembly;
    expect(Array.isArray(assemblies)).toBe(true);
    expect(assemblies.length).toBeGreaterThan(0);
    for (const asm of assemblies) {
      expect(asm._error).toBeUndefined();
    }
  }, 60000);

  it('citation section returns publication data', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', sections: ['citation'] }));
    const citation = result.sections.citation;
    expect(citation).toBeDefined();
    expect(citation._error).toBeUndefined();
  }, 60000);

  it('experiment section returns methods and refinement', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', sections: ['experiment'] }));
    const exp = result.sections.experiment;
    expect(exp).toBeDefined();
    expect(exp._error).toBeUndefined();
    expect(exp.methods).toBeDefined();
  }, 60000);

  it('returns metadata without sections when sections omitted', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN' }));
    expect(result.pdb_id).toBe('1CRN');
    expect(result.summary).toBeDefined();
    expect(result.sections).toBeUndefined();
  }, 60000);

  it('returns 4HHB with all section data having no _error fields', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '4HHB', sections: ['all'] }));
    for (const [name, data] of Object.entries(result.sections as Record<string, any>)) {
      if (Array.isArray(data)) {
        for (const item of data) {
          expect(item._error).toBeUndefined();
        }
      } else if (data && typeof data === 'object') {
        expect(data._error).toBeUndefined();
      }
    }
  }, 60000);

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

  it('returns 404 for nonexistent PDB ID', async () => {
    await expect(
      harness.callTool('pdb', { pdb_id: 'ZZZZ' })
    ).rejects.toThrow(/404|not found/i);
  }, 30000);
});

describe('pdb download mode', () => {
  it('downloads 1CRN in cif format and returns file path', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', download: true, format: 'cif' }));
    expect(result.file).toBeDefined();
    expect(result.file.file_path).toBeTruthy();
    expect(result.file.format).toBe('cif');
    expect(result.file.file_size_bytes).toBeGreaterThan(0);
    expect(result.file.file_size_human).toBeTruthy();
    expect(existsSync(result.file.file_path)).toBe(true);

    const content = readFileSync(result.file.file_path, 'utf-8');
    expect(content).toContain('data_');
    unlinkSync(result.file.file_path);
    const parentDir = result.file.file_path.substring(0, result.file.file_path.lastIndexOf('/'));
    try { rmSync(parentDir, { recursive: true }); } catch {}
  }, 60000);

  it('downloads 1CRN in pdb format with valid content', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', download: true, format: 'pdb' }));
    expect(result.file).toBeDefined();
    expect(result.file.format).toBe('pdb');
    expect(existsSync(result.file.file_path)).toBe(true);

    const content = readFileSync(result.file.file_path, 'utf-8');
    expect(content).toContain('HEADER');
    unlinkSync(result.file.file_path);
    const parentDir = result.file.file_path.substring(0, result.file.file_path.lastIndexOf('/'));
    try { rmSync(parentDir, { recursive: true }); } catch {}
  }, 60000);

  it('includes file size in human-readable format', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', download: true, format: 'cif' }));
    expect(result.file.file_size_human).toMatch(/\d+(\.\d+)?\s*(B|KB|MB|GB)/);
    unlinkSync(result.file.file_path);
    const parentDir = result.file.file_path.substring(0, result.file.file_path.lastIndexOf('/'));
    try { require('node:fs').rmSync(parentDir, { recursive: true }); } catch {}
  }, 60000);

  it('returns metadata and file when downloading with sections', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('pdb', { pdb_id: '1CRN', download: true, format: 'cif', sections: ['experiment'] }));
    expect(result.pdb_id).toBe('1CRN');
    expect(result.summary).toBeDefined();
    expect(result.file).toBeDefined();
    expect(result.file.file_path).toBeTruthy();
    expect(result.sections).toBeDefined();
    expect(result.sections.experiment).toBeDefined();
    unlinkSync(result.file.file_path);
    const parentDir = result.file.file_path.substring(0, result.file.file_path.lastIndexOf('/'));
    try { rmSync(parentDir, { recursive: true }); } catch {}
  }, 60000);
});

describe('pdb pagination', () => {
  it('respects offset parameter', async () => {
    const page1 = await retryOnRateLimit(() => harness.callTool('pdb', { query: 'kinase inhibitor', limit: 2, offset: 0 }));
    const page2 = await retryOnRateLimit(() => harness.callTool('pdb', { query: 'kinase inhibitor', limit: 2, offset: 1 }));
    expect(page1.length).toBeGreaterThan(0);
    expect(page2.length).toBeGreaterThan(0);
    const ids1 = page1.map((r: any) => r.pdb_id);
    const ids2 = page2.map((r: any) => r.pdb_id);
    // Deterministic ordering for the same query: page 2 (offset 1) must start
    // with page 1's second row — proves offset actually shifts the window.
    expect(ids1.length).toBe(2);
    expect(ids2[0]).toBe(ids1[1]);
    expect(ids2[1]).not.toBe(ids1[1]);
  }, 60000);

  it('respects limit parameter across pages', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('pdb', { query: 'protein', limit: 1 }));
    expect(results.length).toBeLessThanOrEqual(1);
  }, 60000);
});

describe('pdb error handling', () => {
  it('errors when neither query nor pdb_id provided', async () => {
    await expect(
      harness.callTool('pdb', {})
    ).rejects.toThrow();
  }, 30000);
});

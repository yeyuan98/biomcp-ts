import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

jest.setTimeout(60000);

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('sra tools (integration)', () => {
  it('sra_get returns experiment details for SRX13898298', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('sra_get', { accession: 'SRX13898298' })
    );
    expect(result.entry_type).toBe('experiment');
    expect(result.accession).toBe('SRX13898298');
    expect(result.library.strategy).toBe('WGS');
    expect(result.library.layout).toBe('PAIRED');
    expect(result.instrument_model).toContain('HiSeq');
  }, 60000);

  it('sra_get returns run details for SRR14432476', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('sra_get', { accession: 'SRR14432476' })
    );
    expect(result.entry_type).toBe('run');
    expect(result.accession).toBe('SRR14432476');
    expect(result.experiment_accession).toBeTruthy();
    // NCBI may reprocess runs — assert numeric presence, not exact equality.
    expect(typeof result.total_spots).toBe('number');
    expect(result.total_spots).toBeGreaterThan(0);
    expect(typeof result.total_bases).toBe('number');
    expect(result.total_bases).toBeGreaterThan(0);
    expect(typeof result.size_bytes).toBe('number');
    expect(result.size_bytes).toBeGreaterThan(0);
  }, 60000);

  it('sra_get returns study details for SRP356657', async () => {
    const result = await retryOnRateLimit(() =>
      harness.callTool('sra_get', { accession: 'SRP356657' })
    );
    expect(result.entry_type).toBe('study');
    expect(result.accession).toBe('SRP356657');
    expect(result.total_experiments).toBeGreaterThan(0);
    expect(result.bioproject).toBe('PRJNA800381');
    expect(result.center_name).toBeTruthy();
    expect(Array.isArray(result.experiments)).toBe(true);
    expect(result.experiments.length).toBeGreaterThan(0);
    expect(result.experiments[0].experiment_accession).toMatch(/^SRX\d+$/);
  }, 60000);

  it('sra_search finds experiments linked to SRP356657', async () => {
    const results = await retryOnRateLimit(() =>
      harness.callTool('sra_search', { query: 'SRP356657', limit: 5 })
    );
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results[0].experiment_accession).toBeTruthy();
    const studyAccessions = results.map((r: any) => r.study_accession);
    expect(studyAccessions).toContain('SRP356657');
    expect(results[0].run_count).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('sra_get rejects ENA accessions with an ENA hint', async () => {
    await expect(
      harness.callTool('sra_get', { accession: 'ERP123456' })
    ).rejects.toThrow(/ENA/i);
  }, 30000);
});

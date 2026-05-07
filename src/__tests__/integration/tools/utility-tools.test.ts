import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('discover', () => {
  it('finds entities for "BRAF"', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('discover', { query: 'BRAF' }));
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  }, 60000);

  it('finds entities for "breast cancer"', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('discover', { query: 'breast cancer' }));
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  }, 60000);

  it('finds entities for "imatinib"', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('discover', { query: 'imatinib' }));
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  }, 60000);
});

describe('batch_get', () => {
  it('fetches multiple entities in parallel', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('batch_get', {
      inputs: [
        { entity: 'gene', id: 'BRCA1' },
        { entity: 'drug', id: 'aspirin' },
      ],
    }));
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);

    const geneResult = results.find((r: any) => r.entity === 'gene');
    const drugResult = results.find((r: any) => r.entity === 'drug');
    expect(geneResult?.success).toBe(true);
    expect(drugResult?.success).toBe(true);
  }, 60000);

  it('handles mixed success and failure gracefully', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('batch_get', {
      inputs: [
        { entity: 'gene', id: 'BRCA1' },
        { entity: 'gene', id: 'INVALIDGENEXYZ999' },
      ],
    }));
    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(2);
  }, 60000);
});

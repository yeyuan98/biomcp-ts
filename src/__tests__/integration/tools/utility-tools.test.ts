import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectDiscoverRows, expectBatchGetRows } from '../../helpers/assertions.js';
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
    expectDiscoverRows(results);
    const entityTypes = (results as Array<Record<string, any>>).map((r) => r.entity_type);
    expect(entityTypes).toContain('gene');
  }, 60000);

  it('finds entities for "breast cancer"', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('discover', { query: 'breast cancer' }));
    expectDiscoverRows(results);
    const entityTypes = (results as Array<Record<string, any>>).map((r) => r.entity_type);
    expect(entityTypes).toContain('disease');
  }, 60000);

  it('finds entities for "imatinib"', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('discover', { query: 'imatinib' }));
    expectDiscoverRows(results);
    const entityTypes = (results as Array<Record<string, any>>).map((r) => r.entity_type);
    expect(entityTypes).toContain('drug');
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
    expectBatchGetRows(results, 2);

    const geneResult = (results as Array<Record<string, any>>).find((r) => r.entity === 'gene');
    const drugResult = (results as Array<Record<string, any>>).find((r) => r.entity === 'drug');
    expect(geneResult?.success).toBe(true);
    expect((geneResult?.data as Record<string, any>)?.symbol).toBe('BRCA1');
    expect(drugResult?.success).toBe(true);
    expect(typeof (drugResult?.data as Record<string, any>)?.name).toBe('string');
  }, 60000);

  it('handles mixed success and failure gracefully', async () => {
    const results = await retryOnRateLimit(() => harness.callTool('batch_get', {
      inputs: [
        { entity: 'gene', id: 'BRCA1' },
        { entity: 'gene', id: 'INVALIDGENEXYZ999' },
      ],
    }));
    expectBatchGetRows(results, 2);

    // The invalid row must be an explicit failure with a reason, not a silent pass.
    const invalidRow = (results as Array<Record<string, any>>).find((r) => r.id === 'INVALIDGENEXYZ999');
    expect(invalidRow?.success).toBe(false);
    expect(typeof invalidRow?.error).toBe('string');
    expect(invalidRow?.error.length).toBeGreaterThan(0);
    const validRow = (results as Array<Record<string, any>>).find((r) => r.id === 'BRCA1');
    expect(validRow?.success).toBe(true);
  }, 60000);
});

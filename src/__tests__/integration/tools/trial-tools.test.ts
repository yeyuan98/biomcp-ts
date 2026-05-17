import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectTrialSearchResult, expectTrialGetResult } from '../../helpers/assertions.js';
import { retryOnRateLimit } from '../../helpers/retry.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('trial_search', () => {
  it('returns trials with valid NCT IDs', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('trial_search', { query: 'breast cancer' }));
    expectTrialSearchResult(response);
    expect(response.studies.length).toBeGreaterThan(0);
    expect(response.studies[0].nct_id).toMatch(/^NCT\d+$/);
  }, 60000);

  it('returns trials with status filter', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('trial_search', { query: 'breast cancer', status: 'Recruiting' }));
    expectTrialSearchResult(response);
    for (const trial of response.studies) {
      if (trial.status) {
        expect(trial.status.toUpperCase()).toBe('RECRUITING');
      }
    }
  }, 60000);

  it('returns empty for nonsense query', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('trial_search', { query: 'ZZZZZNOTATRIAL99999' }));
    expectTrialSearchResult(response);
    expect(response.studies.length).toBe(0);
  }, 60000);

  it('respects limit parameter', async () => {
    const response = await retryOnRateLimit(() => harness.callTool('trial_search', { query: 'cancer', limit: 2 }));
    expectTrialSearchResult(response);
    expect(response.studies.length).toBeLessThanOrEqual(2);
  }, 60000);
});

describe('trial_get', () => {
  it('returns trial by NCT ID', async () => {
    const result = await retryOnRateLimit(() => harness.callTool('trial_get', { nct_id: 'NCT03676114' }));
    expectTrialGetResult(result);
    expect(result.nct_id).toBe('NCT03676114');
  }, 60000);

  it('throws for invalid NCT ID', async () => {
    await expect(
      harness.callTool('trial_get', { nct_id: 'NCT99999999' })
    ).rejects.toThrow();
  }, 30000);
});

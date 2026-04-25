import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { createMcpTestHarness } from '../../helpers/mcp-harness.js';
import { expectTrialSearchResult, expectTrialGetResult } from '../../helpers/assertions.js';

let harness: Awaited<ReturnType<typeof createMcpTestHarness>>;

beforeAll(async () => {
  harness = await createMcpTestHarness();
}, 30000);

afterAll(async () => {
  await harness.close();
});

describe('trial_search', () => {
  it('returns trials with valid NCT IDs', async () => {
    const results = await harness.callTool('trial_search', { query: 'breast cancer' });
    expectTrialSearchResult(results);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nct_id).toMatch(/^NCT\d+$/);
  }, 30000);

  it('returns trials with status filter', async () => {
    const results = await harness.callTool('trial_search', { query: 'breast cancer', status: 'Recruiting' });
    expectTrialSearchResult(results);
    for (const trial of results) {
      if (trial.status) {
        expect(trial.status.toUpperCase()).toBe('RECRUITING');
      }
    }
  }, 30000);

  it('returns empty for nonsense query', async () => {
    const results = await harness.callTool('trial_search', { query: 'ZZZZZNOTATRIAL99999' });
    expectTrialSearchResult(results);
    expect(results.length).toBe(0);
  }, 30000);

  it('respects limit parameter', async () => {
    const results = await harness.callTool('trial_search', { query: 'cancer', limit: 2 });
    expectTrialSearchResult(results);
    expect(results.length).toBeLessThanOrEqual(2);
  }, 30000);
});

describe('trial_get', () => {
  it('returns trial by NCT ID', async () => {
    const result = await harness.callTool('trial_get', { nct_id: 'NCT03676114' });
    expectTrialGetResult(result);
    expect(result.nct_id).toBe('NCT03676114');
  }, 30000);

  it('throws for invalid NCT ID', async () => {
    await expect(
      harness.callTool('trial_get', { nct_id: 'NCT99999999' })
    ).rejects.toThrow();
  }, 30000);
});

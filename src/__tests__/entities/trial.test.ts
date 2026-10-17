import { jest } from '@jest/globals';
import { trialSearch, trialGet, transformTrialResponse } from '../../entities/trial.js';
import { connectionManager } from '../../connections/manager.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';

describe('trial', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
  });

  test('trialSearch() calls connection with correct clinicaltrials endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test Trial' },
            statusModule: {},
            descriptionModule: {},
            armsInterventionsModule: {},
          },
        }],
      }),
    }) as any;

    await trialSearch('breast cancer');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('clinicaltrials.gov');
    expect(callUrl).toContain('/studies?');
    expect(callUrl).toContain('breast+cancer');
  });

  test('trialSearch() returns transformed results', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test Trial', sponsors: [{ name: 'NIH' }] },
            statusModule: { overallStatus: 'RECRUITING', phases: ['PHASE2'] },
            descriptionModule: { conditions: ['Breast Cancer'] },
            armsInterventionsModule: { interventions: [{ type: 'Drug', name: 'Aspirin' }] },
          },
        }],
      }),
    }) as any;

    const response = await trialSearch('breast cancer');

    expect(response.studies).toHaveLength(1);
    expect(response.studies[0].nct_id).toBe('NCT00000001');
    expect(response.studies[0].title).toBe('Test Trial');
    expect(response.studies[0].status).toBe('RECRUITING');
    expect(response.studies[0].sponsor).toBe('NIH');
  });

  test('trialGet() calls connection with correct endpoint', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test Trial', sponsors: [], collaborators: [] },
            statusModule: { overallStatus: 'RECRUITING', phases: [] },
            descriptionModule: {},
            armsInterventionsModule: {},
            contactsLocationsModule: {},
          },
        }],
      }),
    }) as any;

    await trialGet('NCT00000001');

    expect(global.fetch).toHaveBeenCalled();
    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('clinicaltrials.gov');
    expect(callUrl).toContain('/studies/NCT00000001?');
  });

  test('trialSearch() with phase filter uses filter.advanced AREA[Phase]', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { phase: 'Phase 3' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('filter.advanced=');
    expect(callUrl).toContain('AREA%5BPhase%5DPHASE3');
  });

  test('trialSearch() with intervention_type filter uses filter.advanced AREA[InterventionType]', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { intervention_type: 'Drug' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('filter.advanced=');
    expect(callUrl).toContain('AREA%5BInterventionType%5DDRUG');
  });

  test('trialSearch() with both phase and intervention_type joins with AND', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { phase: '2', intervention_type: 'Biological' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('filter.advanced=');
    expect(callUrl).toContain('AREA%5BPhase%5DPHASE2');
    expect(callUrl).toContain('AREA%5BInterventionType%5DBIOLOGICAL');
    // Both parts are in the same filter.advanced value
    const advancedMatch = callUrl.match(/filter\.advanced=([^&]*)/);
    expect(advancedMatch).toBeTruthy();
    const decoded = decodeURIComponent(advancedMatch![1]).replace(/\+/g, ' ');
    expect(decoded).toContain(' AND ');
  });

  test('trialSearch() normalizes phase strings via PHASE_MAP', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { phase: 'early phase 1' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('AREA%5BPhase%5DEARLY_PHASE1');
  });

  test('trialSearch() handles combined phases with slash using OR', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { phase: 'Phase 1/Phase 2' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    const advancedMatch = callUrl.match(/filter\.advanced=([^&]*)/);
    expect(advancedMatch).toBeTruthy();
    const decoded = decodeURIComponent(advancedMatch![1]).replace(/\+/g, ' ');
    expect(decoded).toContain('AREA[Phase]PHASE1');
    expect(decoded).toContain('AREA[Phase]PHASE2');
    expect(decoded).toContain(' OR ');
  });

  test('trialSearch() with status filter still uses filter.overallStatus', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { status: 'recruiting' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('filter.overallStatus=RECRUITING');
    expect(callUrl).not.toContain('filter.advanced');
  });

  test('trialSearch() passes pageToken to API for pagination', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000002', briefTitle: 'Page 2 Trial' },
            statusModule: {},
            descriptionModule: {},
            armsInterventionsModule: {},
          },
        }],
      }),
    }) as any;

    const response = await trialSearch('cancer', { pageToken: 'abc123token' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('pageToken=abc123token');
    expect(response.studies).toHaveLength(1);
    expect(response.studies[0].nct_id).toBe('NCT00000002');
  });

  test('trialSearch() returns nextPageToken from API response', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        nextPageToken: 'next_page_token_xyz',
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test' },
            statusModule: {},
            descriptionModule: {},
            armsInterventionsModule: {},
          },
        }],
      }),
    }) as any;

    const response = await trialSearch('cancer');

    expect(response.nextPageToken).toBe('next_page_token_xyz');
    expect(response.studies).toHaveLength(1);
  });

  test('trialSearch() omits nextPageToken when API has no more pages', async () => {
    global.fetch = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test' },
            statusModule: {},
            descriptionModule: {},
            armsInterventionsModule: {},
          },
        }],
      }),
    }) as any;

    const response = await trialSearch('cancer');

    expect(response.nextPageToken).toBeUndefined();
  });

  test('transformTrialResponse() maps fields correctly', () => {
    const input = {
      protocolSection: {
        identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test Trial' },
        statusModule: { overallStatus: 'RECRUITING', phases: ['PHASE2'] },
      },
    };

    const result = transformTrialResponse(input);

    expect(result).toEqual({
      nct_id: 'NCT00000001',
      title: 'Test Trial',
      status: 'RECRUITING',
      phase: 'PHASE2',
    });
  });
});

describe('trialGet section deadlines (#107 phase 2)', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function studyBody(overrides: Record<string, unknown> = {}): unknown {
    return {
      studies: [{
        protocolSection: {
          identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test Trial' },
          statusModule: { overallStatus: 'RECRUITING', phases: [] },
          descriptionModule: {},
          armsInterventionsModule: {},
          contactsLocationsModule: {},
          ...overrides,
        },
      }],
    };
  }

  test('a section fetch that ignores everything yields a section error by the section deadline; other sections still return', async () => {
    // Call order is deterministic: core fetch first, then the section wave
    // in requested order (eligibility, locations, outcomes).
    let call = 0;
    let eligibilitySignal: AbortSignal | undefined;
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      call += 1;
      if (call === 1) {
        // Core fetch: resolves promptly.
        return Promise.resolve({ ok: true, json: () => Promise.resolve(studyBody()) });
      }
      if (call === 2) {
        // Eligibility: hangs forever AND ignores the abort signal — the
        // worst case the section deadline must still bound.
        eligibilitySignal = init?.signal;
        return new Promise(() => {});
      }
      if (call === 3) {
        // Locations.
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(studyBody({
            contactsLocationsModule: {
              locations: [{ facility: 'Site A', city: 'Boston', state: 'MA', country: 'US' }],
            },
          })),
        });
      }
      // Outcomes.
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(studyBody({
          outcomesModule: {
            primaryOutcomes: [{ measure: 'Overall survival', timeframe: '5 years' }],
          },
        })),
      });
    }) as any;

    const pending = trialGet('NCT00000001', ['eligibility', 'locations', 'outcomes']);
    // Advance past the 8s section deadline (plus rate-limiter spacing).
    await jest.advanceTimersByTimeAsync(9000);
    const result = await pending;

    // Partial-results semantics preserved: the dead section becomes a
    // section-level error entry, the healthy sections still return.
    expect(result.nct_id).toBe('NCT00000001');
    expect(result.sections).toBeDefined();
    const sections = result.sections as Record<string, unknown>;
    expect((sections.eligibility as { error?: string }).error).toContain('timed out after 8000ms');
    expect(sections.locations).toEqual([
      { facility: 'Site A', city: 'Boston', state: 'MA', country: 'US', zip: undefined, status: undefined },
    ]);
    expect(sections.outcomes).toEqual({
      primary: [{ measure: 'Overall survival', timeframe: '5 years' }],
      secondary: [],
    });

    // The phase 2 fix: the 8s race now actually ABORTS the hung request —
    // the fetch's combined signal (deadline + connection timeout) fired.
    expect(eligibilitySignal?.aborted).toBe(true);
  });

  test('threaded caller signal reaches section requests', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    global.fetch = jest.fn<(...args: any[]) => any>().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      seenSignals.push(init?.signal);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(studyBody()) });
    }) as any;

    const callerController = new AbortController();
    const pending = trialGet('NCT00000001', ['locations'], callerController.signal);
    await jest.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(global.fetch).toHaveBeenCalledTimes(2); // core + locations
    expect(result.sections).toBeDefined();
    // Every request carried a signal derived from the caller's (combined
    // with the connection-level timeout via AbortSignal.any in rest.ts —
    // aborting the caller's signal stops them all).
    callerController.abort();
    for (const s of seenSignals) expect(s?.aborted).toBe(true);
  });
});

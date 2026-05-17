import { jest } from '@jest/globals';
import { trialSearch, trialGet, transformTrialResponse } from '../../entities/trial.js';
import { connectionManager } from '../../connections/manager.js';

describe('trial', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    connectionManager.closeAll();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('trialSearch() calls connection with correct clinicaltrials endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { phase: 'Phase 3' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('filter.advanced=');
    expect(callUrl).toContain('AREA%5BPhase%5DPHASE3');
  });

  test('trialSearch() with intervention_type filter uses filter.advanced AREA[InterventionType]', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { intervention_type: 'Drug' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('filter.advanced=');
    expect(callUrl).toContain('AREA%5BInterventionType%5DDRUG');
  });

  test('trialSearch() with both phase and intervention_type joins with AND', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { phase: 'early phase 1' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('AREA%5BPhase%5DEARLY_PHASE1');
  });

  test('trialSearch() handles combined phases with slash using OR', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ studies: [] }),
    }) as any;

    await trialSearch('cancer', { status: 'recruiting' });

    const callUrl = (global.fetch as any).mock.calls[0][0] as string;
    expect(callUrl).toContain('filter.overallStatus=RECRUITING');
    expect(callUrl).not.toContain('filter.advanced');
  });

  test('trialSearch() passes pageToken to API for pagination', async () => {
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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
    global.fetch = jest.fn().mockResolvedValue({
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

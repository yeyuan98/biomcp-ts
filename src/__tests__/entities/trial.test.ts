import { jest } from '@jest/globals';
import { trialSearch, trialGet, transformTrialResponse } from '../../entities/trial.js';

describe('trial', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
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

    const results = await trialSearch('breast cancer');

    expect(results).toHaveLength(1);
    expect(results[0].nct_id).toBe('NCT00000001');
    expect(results[0].title).toBe('Test Trial');
    expect(results[0].status).toBe('RECRUITING');
    expect(results[0].sponsor).toBe('NIH');
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

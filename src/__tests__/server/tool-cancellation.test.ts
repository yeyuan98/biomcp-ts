import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTrialTools } from '../../server/tools/trial.js';
import { registerGeneTools } from '../../server/tools/gene.js';
import { mockGlobalFetch } from '../helpers/mock-fetch.js';
import { connectionManager } from '../../connections/manager.js';

/**
 * Tool-layer MCP cancellation threading (#107 phase 2): callbacks accept
 * `extra.signal` and fail fast — without touching the network — when the
 * signal is already aborted, and reject promptly when it aborts mid-flight.
 * Real modules + global.fetch mocks only (no jest.mock of source modules).
 */
type ToolCallback = (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureTools(register: (server: McpServer) => void): Map<string, ToolCallback> {
  const tools = new Map<string, ToolCallback>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: ToolCallback) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  register(server);
  return tools;
}

describe('MCP cancellation threading at the tool layer', () => {
  mockGlobalFetch();

  beforeEach(() => {
    jest.clearAllMocks();
    connectionManager.closeAll();
    global.fetch = jest.fn<(...args: any[]) => any>();
  });

  it('trial_get: already-aborted extra.signal fails fast without hitting fetch', async () => {
    const tools = captureTools(registerTrialTools);
    const trialGetTool = tools.get('trial_get')!;
    const controller = new AbortController();
    controller.abort();

    const result = await trialGetTool(
      { nct_id: 'NCT00000001', limit: 20 },
      { signal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aborted by the client');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('trial_get: extra.signal aborting mid-flight rejects the call promptly', async () => {
    // fetch never settles — only the threaded abort can end the call.
    (global.fetch as any).mockImplementation(() => new Promise(() => {}));
    const tools = captureTools(registerTrialTools);
    const trialGetTool = tools.get('trial_get')!;

    const controller = new AbortController();
    const pending = trialGetTool({ nct_id: 'NCT00000001', limit: 20 }, { signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aborted by the client');
  });

  it('trial_get: without extra the behavior is unchanged (work runs, fetch happens)', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        studies: [{
          protocolSection: {
            identificationModule: { nctId: 'NCT00000001', briefTitle: 'Test Trial' },
            statusModule: {},
            descriptionModule: {},
            armsInterventionsModule: {},
            contactsLocationsModule: {},
          },
        }],
      }),
    });
    const tools = captureTools(registerTrialTools);
    const trialGetTool = tools.get('trial_get')!;

    const result = await trialGetTool({ nct_id: 'NCT00000001', limit: 20 });
    expect(result.isError).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text).nct_id).toBe('NCT00000001');
  });

  it('gene_get: already-aborted extra.signal fails fast; the entity is never entered', async () => {
    const tools = captureTools(registerGeneTools);
    const geneGetTool = tools.get('gene_get')!;
    const controller = new AbortController();
    controller.abort();

    const result = await geneGetTool(
      { symbol: 'BRAF', limit: 20, smart: false },
      { signal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('aborted by the client');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

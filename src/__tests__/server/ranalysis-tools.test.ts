import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const runDeseq2Mock = jest.fn();
const runEdgerMock = jest.fn();
const runLimmaMock = jest.fn();
const runSessionInfoMock = jest.fn();
const shutdownREngineMock = jest.fn();

jest.unstable_mockModule('../../ranalysis/analyzers.js', () => ({
  runDeseq2: runDeseq2Mock,
  runEdger: runEdgerMock,
  runLimma: runLimmaMock,
  runSessionInfo: runSessionInfoMock,
}));

jest.unstable_mockModule('../../ranalysis/engine.js', () => ({
  rEngine: {},
  shutdownREngine: shutdownREngineMock,
  resetEngineForTests: jest.fn(),
  RAnalysisTimeoutError: class RAnalysisTimeoutError extends Error {},
  RNotAvailableError: class RNotAvailableError extends Error {},
}));

const SAVED_ANALYSIS_R = process.env.ANALYSIS_R;

async function importTools() {
  return import('../../server/tools/ranalysis.js');
}

async function makeServer() {
  const server = new McpServer({ name: 'test-biomcp', version: '1.0.0' });
  const tools = await importTools();
  tools.registerAnalysisRTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const VALID_ARGS = {
  counts: {
    genes: ['g1', 'g2', 'g3'],
    samples: ['c1', 'c2', 't1', 't2'],
    matrix: [[10, 12, 20, 22], [5, 6, 6, 5], [100, 90, 300, 320]],
  },
  coldata: { samples: ['c1', 'c2', 't1', 't2'], columns: { condition: ['ctl', 'ctl', 'trt', 'trt'] } },
  design: 'condition',
  contrast: { variable: 'condition', numerator: 'trt', denominator: 'ctl' },
};

describe('analysis_r_* tool registration and gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.ANALYSIS_R = '1';
  });

  afterEach(() => {
    if (SAVED_ANALYSIS_R === undefined) delete process.env.ANALYSIS_R;
    else process.env.ANALYSIS_R = SAVED_ANALYSIS_R;
  });

  it('registers nothing when ANALYSIS_R is unset', async () => {
    delete process.env.ANALYSIS_R;
    const tools = await importTools();
    const server = new McpServer({ name: 't', version: '1' });
    expect(tools.isAnalysisREnabled()).toBe(false);
    expect(tools.registerAnalysisRToolsIfConfigured(server)).toBe(false);
    expect(WebRInterfaceProbe(server)).toBe(false);
  });

  it('treats ANALYSIS_R=0 and =false as disabled', async () => {
    const tools = await importTools();
    process.env.ANALYSIS_R = '0';
    expect(tools.isAnalysisREnabled()).toBe(false);
    process.env.ANALYSIS_R = 'false';
    expect(tools.isAnalysisREnabled()).toBe(false);
    process.env.ANALYSIS_R = '1';
    expect(tools.isAnalysisREnabled()).toBe(true);
  });

  it('registers all four analysis_r_* tools when enabled', async () => {
    const { client, close } = await makeServer();
    const list = await client.listTools();
    const names = list.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['analysis_r_deseq2', 'analysis_r_edger', 'analysis_r_limma', 'analysis_r_session_info']);
    await close();
  });

  it('analysis_r_deseq2 returns the rendered markdown table', async () => {
    runDeseq2Mock.mockResolvedValue({ text: '## DESeq2 — differential expression\n| gene |\n| g1 |', isJson: false });
    const { client, close } = await makeServer();
    const result = (await client.callTool({ name: 'analysis_r_deseq2', arguments: VALID_ARGS })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('DESeq2');
    expect(runDeseq2Mock).toHaveBeenCalledTimes(1);
    const [, opts] = runDeseq2Mock.mock.calls[0] as unknown as [unknown, { alpha: number; fitType: string; shrink: boolean }];
    expect(opts).toEqual({ alpha: 0.05, fitType: 'parametric', shrink: false });
    await close();
  });

  it('maps analyzer failures to isError with the message', async () => {
    runEdgerMock.mockRejectedValue(new Error('Sample names in counts and coldata must match exactly (missing from coldata: t2).'));
    const { client, close } = await makeServer();
    const result = (await client.callTool({ name: 'analysis_r_edger', arguments: VALID_ARGS })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing from coldata: t2');
    await close();
  });

  it('rejects invalid inputs before touching the engine', async () => {
    const { client, close } = await makeServer();
    const result = (await client.callTool({
      name: 'analysis_r_limma',
      arguments: { ...VALID_ARGS, design: 'batch + condition' },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown coldata column');
    expect(runLimmaMock).not.toHaveBeenCalled();
    await close();
  });

  it('analysis_r_session_info reports runtime state', async () => {
    runSessionInfoMock.mockResolvedValue({ text: '## R analysis session\n| R version |', isJson: false });
    const { client, close } = await makeServer();
    const result = (await client.callTool({ name: 'analysis_r_session_info', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('R analysis session');
    await close();
  });

  it('rejects denylisted design tokens end-to-end', async () => {
    const { client, close } = await makeServer();
    const result = (await client.callTool({
      name: 'analysis_r_deseq2',
      arguments: { ...VALID_ARGS, design: 'q', contrast: undefined },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('disallowed token');
    await close();
  });
});

function WebRInterfaceProbe(server: McpServer): boolean {
  const anyServer = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(anyServer._registeredTools ?? {}).some((name) => name.startsWith('analysis_r_'));
}

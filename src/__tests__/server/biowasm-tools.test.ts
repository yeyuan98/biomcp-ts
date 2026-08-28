import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const runBamSummaryMock = jest.fn();
const runBamViewRegionMock = jest.fn();
const runBcfSummaryMock = jest.fn();
const runBcfViewRegionMock = jest.fn();
const runBedOpMock = jest.fn();
const runConvertMock = jest.fn();
const runSessionInfoMock = jest.fn();
const runCliMock = jest.fn();
const engineRunMock = jest.fn();
const shutdownEngineMock = jest.fn();

jest.unstable_mockModule('../../biowasm/analyzers.js', () => ({
  runBamSummary: runBamSummaryMock,
  runBamViewRegion: runBamViewRegionMock,
  runBcfSummary: runBcfSummaryMock,
  runBcfViewRegion: runBcfViewRegionMock,
  runBedOp: runBedOpMock,
  runConvert: runConvertMock,
  runBiowasmSessionInfo: runSessionInfoMock,
  runBiowasmCli: runCliMock,
}));

jest.unstable_mockModule('../../biowasm/engine.js', () => ({
  biowasmEngine: { run: engineRunMock, ensureReady: jest.fn(), assetsDirectory: () => null, shutdown: jest.fn() },
  shutdownBiowasmEngine: shutdownEngineMock,
  resetBiowasmEngineForTests: jest.fn(),
  BiowasmTimeoutError: class BiowasmTimeoutError extends Error {},
  BiowasmNotAvailableError: class BiowasmNotAvailableError extends Error {},
  BiowasmRuntimeUnresponsiveError: class BiowasmRuntimeUnresponsiveError extends Error {},
}));

const SAVED_ANALYSIS_BIOWASM = process.env.ANALYSIS_BIOWASM;
const SAVED_DATA_DIR = process.env.ANALYSIS_BIOWASM_DATA_DIR;

async function importTools() {
  return import('../../server/tools/biowasm.js');
}

async function makeServer() {
  const server = new McpServer({ name: 'test-biomcp', version: '1.0.0' });
  const tools = await importTools();
  tools.registerBiowasmTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const SAM_CONTENT = [
  '@HD\tVN:1.6\tSO:unsorted',
  '@SQ\tSN:chr1\tLN:1000',
  'r1\t0\tchr1\t10\t60\t4M\t*\t0\t0\tACGT\tIIII',
].join('\n') + '\n';

describe('analysis_biowasm_* tool registration and gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.ANALYSIS_BIOWASM = '1';
    delete process.env.ANALYSIS_BIOWASM_DATA_DIR;
  });

  afterEach(() => {
    if (SAVED_ANALYSIS_BIOWASM === undefined) delete process.env.ANALYSIS_BIOWASM;
    else process.env.ANALYSIS_BIOWASM = SAVED_ANALYSIS_BIOWASM;
    if (SAVED_DATA_DIR === undefined) delete process.env.ANALYSIS_BIOWASM_DATA_DIR;
    else process.env.ANALYSIS_BIOWASM_DATA_DIR = SAVED_DATA_DIR;
  });

  it('registers nothing when ANALYSIS_BIOWASM is unset', async () => {
    delete process.env.ANALYSIS_BIOWASM;
    const tools = await importTools();
    const server = new McpServer({ name: 't', version: '1' });
    expect(tools.isBiowasmEnabled()).toBe(false);
    expect(tools.registerBiowasmToolsIfConfigured(server)).toBe(false);
    expect(BiowasmToolProbe(server)).toBe(false);
  });

  it('treats ANALYSIS_BIOWASM=0 and =false as disabled', async () => {
    const tools = await importTools();
    process.env.ANALYSIS_BIOWASM = '0';
    expect(tools.isBiowasmEnabled()).toBe(false);
    process.env.ANALYSIS_BIOWASM = 'false';
    expect(tools.isBiowasmEnabled()).toBe(false);
    process.env.ANALYSIS_BIOWASM = '1';
    expect(tools.isBiowasmEnabled()).toBe(true);
  });

  it('registers exactly the eight analysis_biowasm tools when enabled', async () => {
    const { client, close } = await makeServer();
    const list = await client.listTools();
    const names = list.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      'analysis_bam_summary',
      'analysis_bam_view_region',
      'analysis_bcf_summary',
      'analysis_bcf_view_region',
      'analysis_bed_op',
      'analysis_biowasm_cli',
      'analysis_biowasm_convert',
      'analysis_biowasm_session_info',
    ]);
    await close();
  });

  it('applies the readOnlyHint rule (summaries + session_info true, data-plane tools false)', async () => {
    const { client, close } = await makeServer();
    const list = await client.listTools();
    const annotations = new Map(list.tools.map((t: { name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }) => [t.name, t.annotations ?? {}]));
    expect(annotations.get('analysis_bam_summary')?.readOnlyHint).toBe(true);
    expect(annotations.get('analysis_bcf_summary')?.readOnlyHint).toBe(true);
    expect(annotations.get('analysis_biowasm_session_info')?.readOnlyHint).toBe(true);
    for (const name of ['analysis_bam_view_region', 'analysis_bcf_view_region', 'analysis_bed_op', 'analysis_biowasm_convert', 'analysis_biowasm_cli']) {
      expect(annotations.get(name)?.readOnlyHint).toBe(false);
    }
    for (const tool of list.tools) {
      expect((tool as { annotations?: { openWorldHint?: boolean } }).annotations?.openWorldHint).toBe(false);
    }
    await close();
  });

  it('analysis_bam_summary returns the rendered markdown', async () => {
    runBamSummaryMock.mockResolvedValue({ text: '## BAM summary\n| in total | 3 + 0 |\n**io_stats:** 1 B read' });
    const { client, close } = await makeServer();
    const result = (await client.callTool({ name: 'analysis_bam_summary', arguments: { source: { content: SAM_CONTENT } } })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('BAM summary');
    expect(result.content[0].text).toContain('io_stats');
    expect(runBamSummaryMock).toHaveBeenCalledTimes(1);
    const [source, output] = runBamSummaryMock.mock.calls[0] as unknown as [
      { kind: string; vfsPath: string },
      { format: string; topN: number; includeContent: boolean },
    ];
    expect(source.kind).toBe('content');
    expect(source.vfsPath).toMatch(/^\/shared\/data\/in-[0-9a-f]{12}\.sam$/);
    expect(output).toEqual({ format: 'table', topN: 50, includeContent: false });
    await close();
  });

  it('maps analyzer failures to isError with the message', async () => {
    runBedOpMock.mockRejectedValue(new Error('op "intersect" requires b_source (the B interval track).'));
    const { client, close } = await makeServer();
    const result = (await client.callTool({ name: 'analysis_bed_op', arguments: { source: { content: 'chr1\t10\t20\n' }, op: 'intersect' } })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires b_source');
    await close();
  });

  it('rejects host_path sources before touching the engine when ANALYSIS_BIOWASM_DATA_DIR is unset', async () => {
    const { client, close } = await makeServer();
    const result = (await client.callTool({
      name: 'analysis_bam_summary',
      arguments: { source: { host_path: '/etc/passwd' } },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ANALYSIS_BIOWASM_DATA_DIR');
    expect(engineRunMock).not.toHaveBeenCalled();
    expect(runBamSummaryMock).not.toHaveBeenCalled();
    await close();
  });

  it('validates cli args before touching the engine', async () => {
    const { client, close } = await makeServer();
    for (const args of [['rmrf', '/'], ['view', '/etc/passwd'], ['view', '-c', 'a;b']]) {
      const result = (await client.callTool({
        name: 'analysis_biowasm_cli',
        arguments: { tool: 'samtools', args },
      })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
    }
    expect(engineRunMock).not.toHaveBeenCalled();
    expect(runCliMock).not.toHaveBeenCalled();
    await close();
  });

  it('analysis_biowasm_session_info reports runtime state', async () => {
    runSessionInfoMock.mockResolvedValue({ text: '## Biowasm analysis session\n| samtools version | 1.21 |' });
    const { client, close } = await makeServer();
    const result = (await client.callTool({ name: 'analysis_biowasm_session_info', arguments: {} })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Biowasm analysis session');
    await close();
  });

  it('passes canonicalized projection and region through to the bcf analyzer', async () => {
    runBcfViewRegionMock.mockResolvedValue({ text: '## Variants\n| CHROM | POS |' });
    const { client, close } = await makeServer();
    const result = (await client.callTool({
      name: 'analysis_bcf_view_region',
      arguments: {
        source: { content: '##fileformat=VCFv4.2\n' },
        region: { chrom: 'chr1', start: 1000, end: 2000 },
        filter: 'QUAL>30',
      },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const [source, region, projection, filter] = runBcfViewRegionMock.mock.calls[0] as unknown as [
      unknown,
      { chrom: string; start?: number; end?: number },
      { fields: string[] },
      string | undefined,
    ];
    expect(source).toBeDefined();
    expect(region).toEqual({ chrom: 'chr1', start: 1000, end: 2000 });
    expect(projection.fields).toEqual(['CHROM', 'POS', 'REF', 'ALT']);
    expect(filter).toBe('QUAL>30');
    await close();
  });
});

function BiowasmToolProbe(server: McpServer): boolean {
  const anyServer = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(anyServer._registeredTools ?? {}).some((name) => name.startsWith('analysis_bam_') || name.startsWith('analysis_biowasm_'));
}

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { connectToolClient, type ToolClient } from '../helpers/mcp-harness.js';

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

async function makeServer(): Promise<ToolClient & { close: () => Promise<void> }> {
  const server = new McpServer({ name: 'test-biomcp', version: '1.0.0' });
  const tools = await importTools();
  tools.registerBiowasmTools(server);
  const tc = await connectToolClient(server);
  return {
    client: tc.client,
    callTool: tc.callTool,
    capturedMessages: tc.capturedMessages,
    progressNotifications: tc.progressNotifications,
    close: async () => {
      await tc.close();
      await server.close();
    },
  };
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

// ---------------------------------------------------------------------------
// Progress forwarding + cancellation over the MCP wire (Fixes A + B). The
// analyzers are mocked at the same boundary the server owns: each mock
// receives the AnalyzerExecOptions the server built from the request extra
// (signal from notifications/cancelled, onProgress from _meta.progressToken)
// and plays the engine's role for it.
// ---------------------------------------------------------------------------

describe('analysis_biowasm_* progress + cancellation (MCP wire, analyzers mocked)', () => {
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

  function cancelledError(): Error {
    return Object.assign(new Error('cancelled by client'), { name: 'BiowasmCancelledError' });
  }

  it('forwards analyzer progress to notifications/progress with one echoed token and a monotonic sequence', async () => {
    runBamSummaryMock.mockImplementation(async (_source, _output, exec) => {
      exec?.onProgress?.({ bytes: 10, elapsedMs: 5, message: 'reading header' });
      await new Promise((r) => setTimeout(r, 15));
      exec?.onProgress?.({ bytes: 250, elapsedMs: 30, message: 'streaming records' });
      await new Promise((r) => setTimeout(r, 15));
      exec?.onProgress?.({ bytes: 900, elapsedMs: 55 });
      return { text: '## BAM summary' };
    });
    const { callTool, progressNotifications, close } = await makeServer();
    const events: Array<{ progress: number; message?: string }> = [];
    const result = (await callTool('analysis_bam_summary', { source: { content: SAM_CONTENT } }, {
      onProgress: (p) => events.push(p),
      raw: true,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();

    // SDK-native flow: the client's onprogress callback received every event.
    expect(events.map((e) => e.progress)).toEqual([10, 250, 900]);
    expect(events[0]!.message).toBe('reading header');

    // Wire truth: notifications/progress messages echo ONE token and carry
    // the same monotonic progress sequence.
    const notes = progressNotifications();
    expect(notes.map((n) => n.progress)).toEqual([10, 250, 900]);
    expect(new Set(notes.map((n) => n.progressToken)).size).toBe(1);
    expect(notes[0]!.message).toBe('reading header');
    await close();
  });

  it('echoes a client-chosen progressToken sent via request _meta', async () => {
    runBamSummaryMock.mockImplementation(async (_source, _output, exec) => {
      exec?.onProgress?.({ bytes: 1, elapsedMs: 1 });
      exec?.onProgress?.({ bytes: 2, elapsedMs: 2 });
      return { text: '## BAM summary' };
    });
    const { callTool, progressNotifications, close } = await makeServer();
    const result = (await callTool('analysis_bam_summary', { source: { content: SAM_CONTENT } }, {
      progressToken: 'biowasm-test-token',
      raw: true,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const notes = progressNotifications();
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.progressToken === 'biowasm-test-token')).toBe(true);
    expect(notes.map((n) => n.progress)).toEqual([1, 2]);
    await close();
  });

  it('sends zero progress notifications when the request carries no token', async () => {
    runBamSummaryMock.mockImplementation(async (_source, _output, exec) => {
      exec?.onProgress?.({ bytes: 5, elapsedMs: 1 }); // forwarder is null → silence
      return { text: '## BAM summary' };
    });
    const { callTool, progressNotifications, close } = await makeServer();
    const result = (await callTool('analysis_bam_summary', { source: { content: SAM_CONTENT } }, { raw: true })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(progressNotifications()).toHaveLength(0);
    await close();
  });

  it('maps BiowasmCancelledError to the cancelled isError result (cancelled content)', async () => {
    runBamSummaryMock.mockRejectedValue(cancelledError());
    const { callTool, close } = await makeServer();
    const result = (await callTool('analysis_bam_summary', { source: { content: SAM_CONTENT } }, { raw: true })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/cancelled by the client/i);
    expect(result.content[0]!.text).toMatch(/no results were produced/);
    await close();
  });

  it('a client cancellation aborts the analyzer through extra.signal (SDK sends notifications/cancelled)', async () => {
    let analyzerAborted = false;
    runBamSummaryMock.mockImplementation(
      (_source, _output, exec) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            analyzerAborted = true;
            reject(cancelledError());
          };
          if (exec?.signal?.aborted) onAbort();
          else exec?.signal?.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const { callTool, close } = await makeServer();
    const controller = new AbortController();
    const pending = callTool('analysis_bam_summary', { source: { content: SAM_CONTENT } }, {
      signal: controller.signal,
      raw: true,
      timeoutMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort('client gave up');
    // The SDK rejects the client-side promise and (verified in the SDK's
    // shared/protocol.js) suppresses the wire response for cancelled requests,
    // so the observable contract here is: analyzer signal fired + McpError.
    const outcome = (await pending.then(
      (v) => ({ result: v }),
      (e: Error & { code?: number }) => ({ error: e }),
    )) as { result?: unknown; error?: Error & { code?: number } };
    expect(analyzerAborted).toBe(true);
    expect(outcome.error).toBeDefined();
    expect(outcome.error!.code).toBe(-32001); // SDK cancel path (ErrorCode.RequestTimeout)
    await close();
  });

  it('CASCADE REGRESSION: a cancelled long-running call does not block the next request', async () => {
    const controller = new AbortController();
    // Long-running analyzer that only settles when its cancellation signal fires.
    runBamSummaryMock.mockImplementation(
      (_source, _output, exec) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(cancelledError());
          if (exec?.signal?.aborted) onAbort();
          else exec?.signal?.addEventListener('abort', onAbort, { once: true });
        }),
    );
    const { callTool, close } = await makeServer();
    const first = callTool('analysis_bam_summary', { source: { content: SAM_CONTENT } }, {
      signal: controller.signal,
      raw: true,
      timeoutMs: 10_000,
    }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await first; // the cancelled call fully settles

    runBamSummaryMock.mockResolvedValue({ text: '## BAM summary\n| fast | 1 |' });
    const started = Date.now();
    const second = (await callTool('analysis_bam_summary', { source: { content: SAM_CONTENT } }, { raw: true })) as {
      content: Array<{ text: string }>;
    };
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(second.content[0]!.text).toContain('BAM summary');
    await close();
  });

  it('threads proceed_on_large_input into the analyzer exec options', async () => {
    runBamSummaryMock.mockResolvedValue({ text: '## BAM summary' });
    const { callTool, close } = await makeServer();
    await callTool('analysis_bam_summary', { source: { content: SAM_CONTENT }, proceed_on_large_input: true }, { raw: true });
    const exec = runBamSummaryMock.mock.calls[0]![2] as { proceedOnLargeInput?: boolean } | undefined;
    expect(exec?.proceedOnLargeInput).toBe(true);
    await close();
  });
});

function BiowasmToolProbe(server: McpServer): boolean {
  const anyServer = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(anyServer._registeredTools ?? {}).some((name) => name.startsWith('analysis_bam_') || name.startsWith('analysis_biowasm_'));
}

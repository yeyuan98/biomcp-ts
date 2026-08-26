import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const captureRMock = jest.fn();
const purgeMock = jest.fn();
const initMock = jest.fn();
const closeMock = jest.fn();
const interruptMock = jest.fn();
const evalRMock = jest.fn();
const mkdirMock = jest.fn();
const writeFileMock = jest.fn();

const shelterMock = { captureR: captureRMock, purge: purgeMock };

const webRInstance = {
  init: initMock,
  close: closeMock,
  interrupt: interruptMock,
  evalR: evalRMock,
  FS: { mkdir: mkdirMock, writeFile: writeFileMock },
  Shelter: jest.fn(() => Promise.resolve(shelterMock)),
};

const WebRMock = jest.fn(() => webRInstance);

jest.unstable_mockModule('webr', () => ({ WebR: WebRMock }));

const startServerSpy = jest.fn(async () => 'http://127.0.0.1:65535');
const closeServerSpy = jest.fn(async () => undefined);

jest.unstable_mockModule('../../ranalysis/mirror.js', () => ({
  resolveMirror: jest.fn(async () => ({ dir: '/fake/mirror', origin: 'env-dir' })),
  MirrorServer: jest.fn().mockImplementation(() => ({ start: startServerSpy, close: closeServerSpy, url: () => 'http://127.0.0.1:65535' })),
  MirrorError: class MirrorError extends Error {},
}));

const ENV_KEYS = ['ANALYSIS_R_TIMEOUT_MS', 'ANALYSIS_R_MEM_LIMIT_MB'] as const;
const SAVED_ENV: Record<string, string | undefined> = {};

async function importEngine() {
  const mod = await import('../../ranalysis/engine.js');
  mod.resetEngineForTests();
  return mod;
}

describe('R analysis engine', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      SAVED_ENV[k] = process.env[k];
      delete process.env[k];
    }
    jest.clearAllMocks();
    jest.resetModules();
    evalRMock.mockResolvedValue({ toString: async () => 'R version 4.6.0 (2026-08-27)' });
    captureRMock.mockImplementation(async (code: string) => {
      if (code.includes('webr::install')) {
        return { result: { toString: async () => 'INSTALL_OK' } };
      }
      if (code.includes('r_version')) {
        return { result: { toString: async () => '{"r_version":"R 4.6.0"}' } };
      }
      return { result: { toString: async () => '{"summary":{},"columns":[],"top":[],"warnings":[]}' } };
    });
    initMock.mockResolvedValue(undefined);
    closeMock.mockResolvedValue(undefined);
    mkdirMock.mockRejectedValue(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }));
    writeFileMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const mod = await import('../../ranalysis/engine.js');
    await mod.shutdownREngine();
    for (const k of ENV_KEYS) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k]!;
    }
  });

  it('bootstraps once: webR init, mirror server, package install', async () => {
    const { rEngine } = await importEngine();
    await rEngine.ensureReady();
    await rEngine.ensureReady();
    expect(WebRMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(startServerSpy).toHaveBeenCalledTimes(1);
    expect(captureRMock).toHaveBeenCalledTimes(1);
    expect(String(captureRMock.mock.calls[0][0])).toContain('webr::install(c("DESeq2", "edgeR", "limma", "jsonlite")');
    expect(String(captureRMock.mock.calls[0][0])).toContain('"INSTALL_OK"');
    expect(purgeMock).toHaveBeenCalled();
  });

  it('runs a script and returns the parsed JSON payload with purge cleanup', async () => {
    const { rEngine } = await importEngine();
    const { payload, rVersion } = await rEngine.runScript('x');
    expect(payload).toEqual({ summary: {}, columns: [], top: [], warnings: [] });
    expect(rVersion).toBe('R version 4.6.0 (2026-08-27)');
    expect(purgeMock).toHaveBeenCalled();
  });

  it('maps interrupted evaluations to a timeout error', async () => {
    process.env.ANALYSIS_R_TIMEOUT_MS = '50';
    const { rEngine, RAnalysisTimeoutError } = await importEngine();
    await rEngine.ensureReady();
    captureRMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('A non-local transfer of control occurred during evaluation')), 500);
        })
    );
    await expect(rEngine.runScript('Sys.sleep(1000)')).rejects.toBeInstanceOf(RAnalysisTimeoutError);
    expect(interruptMock).toHaveBeenCalled();
  });

  it('propagates R errors with their messages', async () => {
    captureRMock.mockRejectedValue(new Error("Error in eval: there is no package called 'locfit'"));
    const { rEngine } = await importEngine();
    await expect(rEngine.runScript('bad')).rejects.toThrow(/locfit/);
  });

  it('refuses to start when memory exceeds the watermark', async () => {
    process.env.ANALYSIS_R_MEM_LIMIT_MB = '1';
    const { rEngine } = await importEngine();
    await rEngine.ensureReady();
    await expect(rEngine.runScript('x')).rejects.toThrow(/ANALYSIS_R_MEM_LIMIT_MB/);
  });

  it('serializes jobs through the single-flight queue', async () => {
    const order: string[] = [];
    captureRMock.mockImplementation(async (code: string) => {
      if (code.includes('webr::install')) {
        return { result: { toString: async () => 'INSTALL_OK' } };
      }
      order.push('start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('end');
      return { result: { toString: async () => '{"summary":{},"columns":[],"top":[],"warnings":[]}' } };
    });
    const { rEngine } = await importEngine();
    await rEngine.ensureReady();
    const p1 = rEngine.runScript('a');
    const p2 = rEngine.runScript('b');
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });

  it('writes inputs into the VFS under /input after readiness', async () => {
    const { rEngine } = await importEngine();
    await rEngine.writeInput('counts.csv', 'gene,s1\ng1,1\n');
    expect(writeFileMock).toHaveBeenCalledWith('/input/counts.csv', expect.any(Uint8Array));
  });

  it('reports session info through the queue', async () => {
    const { rEngine } = await importEngine();
    const { payload } = await rEngine.sessionInfo();
    expect(payload).toEqual({ r_version: 'R 4.6.0' });
  });

  it('shuts down the mirror server and webR', async () => {
    const { rEngine } = await importEngine();
    await rEngine.ensureReady();
    await rEngine.shutdown();
    expect(closeServerSpy).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();
  });
});

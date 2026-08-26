import { resolveMirror, MirrorServer, MirrorError } from './mirror.js';
import { SESSION_INFO_SCRIPT } from './rscripts.js';

type WebRModule = typeof import('webr');
type WebRInstance = import('webr').WebR;

const INSTALL_PACKAGES = ['DESeq2', 'edgeR', 'limma', 'jsonlite'];
const INTERRUPT_SIGNATURE = 'non-local transfer of control';

export class RAnalysisTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RAnalysisTimeoutError';
  }
}

export class RNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RNotAvailableError';
  }
}

export interface EngineRunResult {
  payload: Record<string, unknown>;
  rVersion: string;
}

function timeoutMs(): number {
  const v = Number(process.env.ANALYSIS_R_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

function memLimitBytes(): number {
  const v = Number(process.env.ANALYSIS_R_MEM_LIMIT_MB);
  const mb = Number.isFinite(v) && v > 0 ? v : 2048;
  return mb * 1024 * 1024;
}

class REngine {
  private webrMod: WebRModule | null = null;
  private webR: WebRInstance | null = null;
  private readyPromise: Promise<void> | null = null;
  private queueTail: Promise<unknown> = Promise.resolve();
  private mirrorServer: MirrorServer | null = null;
  private mirrorUrl: string | null = null;
  private rVersion = '';

  async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.bootstrap().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  private async bootstrap(): Promise<void> {
    try {
      this.webrMod = await import('webr');
    } catch {
      throw new RNotAvailableError(
        'The webr package is not installed. Install it next to biomcp (npm install webr) and set ANALYSIS_R=1 to enable R analysis tools.'
      );
    }
    try {
      this.webR = new this.webrMod.WebR();
      await this.webR.init();
    } catch (err) {
      this.webR = null;
      throw new RNotAvailableError(`Failed to start the webR (Wasm R) runtime: ${String(err)}`);
    }
    try {
      const resolution = await resolveMirror();
      this.mirrorServer = new MirrorServer();
      this.mirrorUrl = await this.mirrorServer.start(resolution.dir);
    } catch (err) {
      await this.shutdown();
      if (err instanceof MirrorError) throw err;
      throw new MirrorError(`Failed to provision the wasm package mirror: ${String(err)}`);
    }
    try {
      this.rVersion = await this.evalRString('R.version.string');
      const rPackages = `c(${INSTALL_PACKAGES.map((p) => JSON.stringify(p)).join(', ')})`;
      const installResult = await this.captureRaw(
        `options(repos = c(MIRROR = ${JSON.stringify(this.mirrorUrl)}))\n` +
          `suppressWarnings(webr::install(${rPackages}, repos = getOption("repos")))\n` +
          `"INSTALL_OK"`,
        Math.max(timeoutMs() * 3, 1_800_000)
      );
      if (!installResult.includes('INSTALL_OK')) {
        throw new MirrorError('Package installation did not complete: ' + installResult.slice(0, 200));
      }
    } catch (err) {
      await this.shutdown();
      if (err instanceof RAnalysisTimeoutError) throw err;
      throw new MirrorError(
        `Failed to install R analysis packages from the mirror: ${extractMessage(err)}. ` +
          'If the mirror is unreachable, set ANALYSIS_R_MIRROR_URL to a local bundle directory or archive.'
      );
    }
  }

  private async evalRString(code: string): Promise<string> {
    const w = this.webR!;
    const r = await w.evalR(code);
    return await r.toString();
  }

  private async captureRaw(code: string, timeout: number): Promise<string> {
    const shelter = await new this.webR!.Shelter();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        this.webR!.interrupt();
      } catch {
        /* interrupt best-effort */
      }
    }, timeout);
    try {
      const out = await shelter.captureR(code);
      return await out.result.toString();
    } catch (err) {
      const msg = extractMessage(err);
      if (timedOut || msg.includes(INTERRUPT_SIGNATURE)) {
        throw new RAnalysisTimeoutError(
          `R analysis exceeded the time limit (${Math.round(timeout / 1000)}s) and was interrupted. Raise ANALYSIS_R_TIMEOUT_MS or reduce input size.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      try {
        await shelter.purge();
      } catch {
        /* purge best-effort */
      }
    }
  }

  private async capture(code: string, timeout: number): Promise<Record<string, unknown>> {
    const text = await this.captureRaw(code, timeout);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`R analysis returned an unexpected payload (not JSON): ${text.slice(0, 200)}`);
    }
  }

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(job, job);
    this.queueTail = run.catch(() => undefined);
    return run;
  }

  async checkMemory(): Promise<void> {
    const rss = process.memoryUsage().rss;
    if (rss > memLimitBytes()) {
      throw new Error(
        `Memory usage (${(rss / 1024 / 1024).toFixed(0)} MB) exceeds ANALYSIS_R_MEM_LIMIT_MB (${Math.round(memLimitBytes() / 1024 / 1024)} MB); refusing a new analysis.`
      );
    }
  }

  async writeInput(filename: string, content: string): Promise<void> {
    await this.ensureReady();
    const w = this.webR!;
    try {
      await w.FS.mkdir('/input');
    } catch {
      /* exists */
    }
    await w.FS.writeFile(`/input/${filename}`, new TextEncoder().encode(content));
  }

  async runScript(code: string): Promise<EngineRunResult> {
    await this.ensureReady();
    await this.checkMemory();
    return this.enqueue(async () => {
      const payload = await this.capture(code, timeoutMs());
      return { payload, rVersion: this.rVersion };
    });
  }

  async sessionInfo(): Promise<EngineRunResult> {
    await this.ensureReady();
    return this.enqueue(async () => {
      const payload = await this.capture(SESSION_INFO_SCRIPT, Math.min(timeoutMs(), 120_000));
      return { payload, rVersion: this.rVersion };
    });
  }

  mirrorEndpoint(): string | null {
    return this.mirrorUrl;
  }

  async shutdown(): Promise<void> {
    this.queueTail = Promise.resolve();
    if (this.mirrorServer) {
      await this.mirrorServer.close();
      this.mirrorServer = null;
      this.mirrorUrl = null;
    }
    if (this.webR) {
      try {
        await this.webR.close();
      } catch {
        /* best-effort */
      }
      this.webR = null;
    }
    this.webrMod = null;
    this.readyPromise = null;
  }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const rEngine = new REngine();

export async function shutdownREngine(): Promise<void> {
  await rEngine.shutdown();
}

export function resetEngineForTests(): void {
  void rEngine.shutdown();
}

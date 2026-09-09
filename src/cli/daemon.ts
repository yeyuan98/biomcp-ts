import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readTraceDatabaseMetrics } from '../remote/tracer.js';

export interface DaemonState {
  pid: number;
  startedAt: number;
  host: string;
  port: number;
  traceFile?: string;
}

export function getDaemonDir(): string {
  const dir = process.env.BIOMCP_HOME ?? join(homedir(), '.biomcp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDaemonStatePath(): string {
  return join(getDaemonDir(), 'daemon.json');
}

export function readDaemonState(): DaemonState | null {
  try {
    const file = getDaemonStatePath();
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as DaemonState;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  const file = getDaemonStatePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function removeDaemonState(): void {
  try {
    const file = getDaemonStatePath();
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    // Ignore error
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (pid === process.pid) {
      return true;
    }
    // On Linux, verify cmdline to avoid killing recycled PIDs
    if (process.platform === 'linux') {
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (existsSync(cmdlinePath)) {
        const cmdline = readFileSync(cmdlinePath, 'utf8');
        return (
          cmdline.includes('biomcp') ||
          cmdline.includes('cli.js') ||
          cmdline.includes('serve')
        );
      }
    }
    return true;
  } catch {
    return false;
  }
}

export interface DaemonOptions {
  host?: string;
  port?: number;
  token?: string;
  trace?: boolean;
  traceFile?: string;
  tracePeriodDays?: number;
  insecureNoAuth?: boolean;
}

export async function startDaemon(cliPath: string, options?: DaemonOptions): Promise<void> {
  const existing = readDaemonState();
  if (existing && isProcessRunning(existing.pid)) {
    console.error(
      `Biomcp daemon is already running (PID: ${existing.pid}) on http://${existing.host}:${existing.port}. Use 'biomcp daemon stop' first.`,
    );
    process.exitCode = 1;
    return;
  }

  const host = options?.host ?? '127.0.0.1';
  const port = options?.port ?? 3000;

  const daemonDir = getDaemonDir();
  const outLog = join(daemonDir, 'daemon.out');
  const errLog = join(daemonDir, 'daemon.err');

  const outFd = openSync(outLog, 'a');
  const errFd = openSync(errLog, 'a');

  const childArgs = [cliPath, 'serve', '--host', host, '--port', String(port)];
  if (options?.trace) childArgs.push('--trace');
  if (options?.traceFile) childArgs.push('--trace-file', options.traceFile);
  if (options?.tracePeriodDays) childArgs.push('--trace-period-days', String(options.tracePeriodDays));
  if (options?.insecureNoAuth) childArgs.push('--insecure-no-auth');

  // Pass token safely via environment to avoid leaking in `ps aux` or /proc
  const childEnv = { ...process.env };
  if (options?.token) {
    childEnv.BIOMCP_AUTH_TOKENS = options.token;
  }

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: childEnv,
  });

  // Close parent copies of log file descriptors
  try {
    closeSync(outFd);
    closeSync(errFd);
  } catch {
    // Ignore
  }

  child.unref();

  const pid = child.pid;
  if (!pid) {
    console.error('Failed to spawn daemon process.');
    process.exitCode = 1;
    return;
  }

  // Poll /health for up to 5 seconds
  const start = Date.now();
  let healthy = false;
  const healthUrl = `http://${host}:${port}/health`;

  while (Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 250));
    if (!isProcessRunning(pid)) break;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Retry
    }
  }

  if (healthy) {
    const traceFile = options?.traceFile
      ? resolve(options.traceFile)
      : options?.trace
        ? resolve('biomcp-traces.db')
        : undefined;

    writeDaemonState({
      pid,
      startedAt: Date.now(),
      host,
      port,
      traceFile,
    });
    console.log(`Biomcp daemon started successfully on http://${host}:${port} (PID: ${pid}).`);
    console.log(`Logs: ${outLog} / ${errLog}`);
  } else {
    console.error(`Failed to start biomcp daemon. Process exited or did not respond on ${healthUrl}.`);
    try {
      if (existsSync(errLog)) {
        const errText = readFileSync(errLog, 'utf8').trim().slice(-500);
        if (errText) console.error(`Last error logs:\n${errText}`);
      }
    } catch {
      // Ignore read error
    }
    if (isProcessRunning(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore
      }
    }
    process.exitCode = 1;
  }
}

export async function stopDaemon(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    console.log('No biomcp daemon state found.');
    return;
  }

  if (!isProcessRunning(state.pid)) {
    console.log(`Daemon process (PID: ${state.pid}) not running. Removing stale state.`);
    removeDaemonState();
    return;
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to send SIGTERM to PID ${state.pid}: ${String(err)}`);
    process.exitCode = 1;
    return;
  }

  const start = Date.now();
  while (Date.now() - start < 15_000) {
    if (!isProcessRunning(state.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (isProcessRunning(state.pid)) {
    console.warn(`Daemon process did not terminate within 15s. Sending SIGKILL.`);
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // Ignore
    }
  }

  removeDaemonState();
  console.log(`Biomcp daemon (PID: ${state.pid}) stopped.`);
}

export async function statusDaemon(): Promise<void> {
  const state = readDaemonState();
  if (!state) {
    console.log('Biomcp daemon is not running.');

    const candidateTraceFiles = [
      process.env.BIOMCP_TRACE_FILE,
      'biomcp-traces.db',
      join(getDaemonDir(), 'biomcp-traces.db'),
    ].filter((p): p is string => typeof p === 'string' && Boolean(p));

    for (const p of candidateTraceFiles) {
      const traceMetrics = readTraceDatabaseMetrics(p);
      if (traceMetrics) {
        console.log(`\nTrace Database (${traceMetrics.filePath}):`);
        console.log(`  DB Size:     ${Math.round(traceMetrics.fileSizeBytes / 1024)} KB`);
        if (traceMetrics.periodStart || traceMetrics.periodEnd) {
          console.log(`  Period:      ${traceMetrics.periodStart ?? 'n/a'} -> ${traceMetrics.periodEnd ?? 'n/a'}`);
        }
        console.log(`  HTTP Logs:   ${traceMetrics.totalHttpRecords}`);
        console.log(`  Tool Logs:   ${traceMetrics.totalToolRecords}`);
        if (traceMetrics.archiveFiles.length > 0) {
          console.log(`  Archives:    ${traceMetrics.archiveFiles.length} file(s)`);
          for (const arch of traceMetrics.archiveFiles) {
            console.log(`    - ${arch.name} (${Math.round(arch.sizeBytes / 1024)} KB)`);
          }
        }
        break;
      }
    }
    return;
  }

  const running = isProcessRunning(state.pid);
  if (!running) {
    console.log(`Biomcp daemon state exists (PID: ${state.pid}), but process is not running (stale).`);
    removeDaemonState();
    return;
  }

  const uptimeSec = Math.round((Date.now() - state.startedAt) / 1000);
  let healthOk = false;
  try {
    const res = await fetch(`http://${state.host}:${state.port}/health`, { signal: AbortSignal.timeout(2000) });
    healthOk = res.ok;
  } catch {
    healthOk = false;
  }

  console.log(`Biomcp daemon is running.`);
  console.log(`  PID:     ${state.pid}`);
  console.log(`  Target:  http://${state.host}:${state.port}`);
  console.log(`  Health:  ${healthOk ? 'healthy (HTTP 200)' : 'unresponsive'}`);
  console.log(`  Uptime:  ${uptimeSec}s`);
  console.log(`  Dir:     ${getDaemonDir()}`);

  const candidateTraceFiles = [
    state.traceFile,
    process.env.BIOMCP_TRACE_FILE,
    'biomcp-traces.db',
    join(getDaemonDir(), 'biomcp-traces.db'),
  ].filter((p): p is string => typeof p === 'string' && Boolean(p));

  let traceMetrics = null;
  for (const p of candidateTraceFiles) {
    traceMetrics = readTraceDatabaseMetrics(p);
    if (traceMetrics) break;
  }

  if (traceMetrics) {
    console.log(`  Traces:  active (${traceMetrics.filePath})`);
    console.log(`    DB Size:     ${Math.round(traceMetrics.fileSizeBytes / 1024)} KB`);
    if (traceMetrics.periodStart || traceMetrics.periodEnd) {
      console.log(`    Period:      ${traceMetrics.periodStart ?? 'n/a'} -> ${traceMetrics.periodEnd ?? 'n/a'}`);
    }
    console.log(`    HTTP Logs:   ${traceMetrics.totalHttpRecords}`);
    console.log(`    Tool Logs:   ${traceMetrics.totalToolRecords}`);
    if (traceMetrics.archiveFiles.length > 0) {
      console.log(`    Archives:    ${traceMetrics.archiveFiles.length} file(s)`);
      for (const arch of traceMetrics.archiveFiles) {
        console.log(`      - ${arch.name} (${Math.round(arch.sizeBytes / 1024)} KB)`);
      }
    }
  } else {
    console.log(`  Traces:  disabled / not active`);
  }
}

export async function restartDaemon(cliPath: string, options?: DaemonOptions): Promise<void> {
  await stopDaemon();
  await new Promise((r) => setTimeout(r, 500));
  await startDaemon(cliPath, options);
}

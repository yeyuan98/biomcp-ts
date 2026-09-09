import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import {
  getDaemonDir,
  getDaemonStatePath,
  isProcessRunning,
  readDaemonState,
  removeDaemonState,
  statusDaemon,
  writeDaemonState,
} from '../../cli/daemon.js';
import { Tracer } from '../../remote/tracer.js';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAVED_HOME = process.env.BIOMCP_HOME;
const WORK = join(tmpdir(), `biomcp-daemon-test-${Date.now()}`);

beforeEach(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  process.env.BIOMCP_HOME = WORK;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIOMCP_HOME;
  else process.env.BIOMCP_HOME = SAVED_HOME;
  rmSync(WORK, { recursive: true, force: true });
});

describe('Daemon state file & process management', () => {
  it('manages daemon state file lifecycle', () => {
    expect(readDaemonState()).toBeNull();

    const state = {
      pid: process.pid,
      startedAt: Date.now(),
      host: '127.0.0.1',
      port: 3000,
    };

    writeDaemonState(state);
    expect(existsSync(getDaemonStatePath())).toBe(true);

    const read = readDaemonState();
    expect(read).toEqual(state);

    removeDaemonState();
    expect(readDaemonState()).toBeNull();
  });

  it('detects running and non-running processes', () => {
    // Current process is definitely running
    expect(isProcessRunning(process.pid)).toBe(true);

    // Non-existent PID
    expect(isProcessRunning(9999999)).toBe(false);
  });

  it('statusDaemon reports offline metrics when trace database is present', async () => {
    const dbPath = join(WORK, 'biomcp-traces.db');
    const tracer = new Tracer({ enabled: true, filePath: dbPath });
    tracer.recordHttp('GET', '/health', 200, 5, 'anonymous');
    tracer.close();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    try {
      await statusDaemon();
      const output = logs.join('\n');
      expect(output).toContain('Biomcp daemon is not running');
      expect(output).toContain('Trace Database');
      expect(output).toContain('HTTP Logs:   1');
    } finally {
      console.log = origLog;
    }
  });
});

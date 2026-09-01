import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parseCliArgs, serverModeNotice } from '../../cli/args.js';

describe('parseCliArgs (dispatch contract)', () => {
  const cases: { argv: string[]; command: string; json?: boolean; client?: string }[] = [
    { argv: [], command: 'server' },
    { argv: ['--help'], command: 'help' },
    { argv: ['-h'], command: 'help' },
    { argv: ['--version'], command: 'version' },
    { argv: ['-v'], command: 'version' },
    { argv: ['doctor'], command: 'doctor' },
    { argv: ['doctor', '--json'], command: 'doctor', json: true },
    { argv: ['doctor', '--client', 'opencode'], command: 'doctor', client: 'opencode' },
    { argv: ['doctor', '--json', '--client', 'codex'], command: 'doctor', json: true, client: 'codex' },
    // backward compat: anything unrecognized must stay server mode (the server
    // entry never reads argv; clients may pass stray args)
    { argv: ['serve'], command: 'server' },
    { argv: ['run'], command: 'server' },
    { argv: ['--bogus'], command: 'server' },
    { argv: ['gene_search'], command: 'server' },
    { argv: ['doctor', '--bogus'], command: 'server' },
    { argv: ['--help', 'extra'], command: 'server' },
  ];

  for (const c of cases) {
    it(`${JSON.stringify(c.argv)} -> ${c.command}`, () => {
      const parsed = parseCliArgs(c.argv);
      expect(parsed.command).toBe(c.command);
      expect(parsed.json).toBe(c.json ?? false);
      if (c.client !== undefined) expect(parsed.client).toBe(c.client);
    });
  }
});

describe('serverModeNotice (stderr-only, behavior-invariant)', () => {
  const NOTICED: string[][] = [['run'], ['run', '--toolset', 'python'], ['run', '--help']];
  for (const argv of NOTICED) {
    it(`${JSON.stringify(argv)} -> explains the retired Python-BioMCP invocation`, () => {
      const notice = serverModeNotice(argv);
      expect(notice).not.toBeNull();
      expect(notice).toContain('Python BioMCP');
      expect(notice).toContain('AGENT-INSTALL');
      expect(notice).toContain('doctor');
    });
  }
  const SILENT: string[][] = [[], ['serve'], ['--stray'], ['--help'], ['doctor'], ['doctor', '--bogus'], ['Run']];
  for (const argv of SILENT) {
    it(`${JSON.stringify(argv)} -> no notice`, () => {
      expect(serverModeNotice(argv)).toBeNull();
    });
  }
});

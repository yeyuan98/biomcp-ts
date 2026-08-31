import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parseCliArgs } from '../../cli/args.js';

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

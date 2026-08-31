/**
 * Minimal argv parsing for the `biomcp` CLI. Zero imports beyond node:* — pure
 * and unit-testable. Dispatch rule: the FIRST argument decides the command;
 * anything unrecognized (including stray args some clients may append) falls
 * back to server mode, matching today's behavior where the server entry never
 * reads process.argv.
 */

export type CliCommand = 'server' | 'help' | 'version' | 'doctor';

export interface ParsedCliArgs {
  command: CliCommand;
  json: boolean;
  client?: string;
  unknown: string[];
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [first] = argv;
  if (argv.length === 1 && (first === '--help' || first === '-h')) return { command: 'help', json: false, unknown: [] };
  if (argv.length === 1 && (first === '--version' || first === '-v')) return { command: 'version', json: false, unknown: [] };
  if (first === 'doctor') {
    const rest = argv.slice(1);
    const json = rest.includes('--json');
    let client: string | undefined;
    const unknown: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--json') continue;
      if (rest[i] === '--client') {
        client = rest[i + 1];
        i++;
        continue;
      }
      unknown.push(rest[i]);
    }
    // unknown flags on doctor fall back to server mode: any unrecognized argv
    // must never change what bare `biomcp` does (stray client args, typos)
    if (unknown.length > 0) return { command: 'server', json: false, unknown };
    return { command: 'doctor', json, client, unknown };
  }
  return { command: 'server', json: false, unknown: [] };
}

/**
 * Minimal argv parsing for the `biomcp` CLI. Zero imports beyond node:* — pure
 * and unit-testable. Dispatch rule: the FIRST argument decides the command;
 * anything unrecognized (including stray args some clients may append) falls
 * back to server mode, matching today's behavior where the server entry never
 * reads process.argv.
 */

export type CliCommand = 'server' | 'help' | 'version' | 'doctor' | 'serve' | 'daemon' | 'remote';

export interface ParsedCliArgs {
  command: CliCommand;
  json: boolean;
  client?: string;
  unknown: string[];
  subcommand?: string;
  host?: string;
  port?: number;
  token?: string;
  trace?: boolean;
  traceFile?: string;
  insecureNoAuth?: boolean;
  domain?: string;
  user?: string;
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

  if (first === 'serve') {
    const rest = argv.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      return { command: 'help', json: false, unknown: [] };
    }
    let host: string | undefined;
    let port: number | undefined;
    let token: string | undefined;
    let trace: boolean | undefined;
    let traceFile: string | undefined;
    let insecureNoAuth: boolean | undefined;
    const unknown: string[] = [];

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--host' || arg === '-h') {
        host = rest[++i];
      } else if (arg === '--port' || arg === '-p') {
        port = parseInt(rest[++i], 10);
      } else if (arg === '--token' || arg === '-t') {
        token = rest[++i];
      } else if (arg === '--trace') {
        trace = true;
      } else if (arg === '--trace-file') {
        traceFile = rest[++i];
      } else if (arg === '--insecure-no-auth') {
        insecureNoAuth = true;
      } else {
        unknown.push(arg);
      }
    }
    return { command: 'serve', json: false, host, port, token, trace, traceFile, insecureNoAuth, unknown };
  }

  if (first === 'daemon') {
    const rest = argv.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      return { command: 'help', json: false, unknown: [] };
    }
    const subcommand = rest[0];
    let host: string | undefined;
    let port: number | undefined;
    let token: string | undefined;
    let trace: boolean | undefined;
    let traceFile: string | undefined;
    let insecureNoAuth: boolean | undefined;
    const unknown: string[] = [];

    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--host' || arg === '-h') {
        host = rest[++i];
      } else if (arg === '--port' || arg === '-p') {
        port = parseInt(rest[++i], 10);
      } else if (arg === '--token' || arg === '-t') {
        token = rest[++i];
      } else if (arg === '--trace') {
        trace = true;
      } else if (arg === '--trace-file') {
        traceFile = rest[++i];
      } else if (arg === '--insecure-no-auth') {
        insecureNoAuth = true;
      } else {
        unknown.push(arg);
      }
    }
    return { command: 'daemon', json: false, subcommand, host, port, token, trace, traceFile, insecureNoAuth, unknown };
  }

  if (first === 'remote') {
    const rest = argv.slice(1);
    if (rest.includes('--help') || rest.includes('-h')) {
      return { command: 'help', json: false, unknown: [] };
    }
    const subcommand = rest[0];
    let domain: string | undefined;
    let port: number | undefined;
    let host: string | undefined;
    let user: string | undefined;
    const unknown: string[] = [];

    for (let i = 1; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--domain' || arg === '-d') {
        domain = rest[++i];
      } else if (arg === '--port' || arg === '-p') {
        port = parseInt(rest[++i], 10);
      } else if (arg === '--host' || arg === '-h') {
        host = rest[++i];
      } else if (arg === '--user' || arg === '-u') {
        user = rest[++i];
      } else {
        unknown.push(arg);
      }
    }
    return { command: 'remote', json: false, subcommand, domain, port, host, user, unknown };
  }

  return { command: 'server', json: false, unknown: [] };
}

/**
 * stderr-only notice when argv looks like the retired Python-BioMCP server
 * invocation; never changes behavior (server mode proceeds regardless).
 * MCP clients spawn bare `biomcp` (no argv) and never see it.
 */
export function serverModeNotice(argv: string[]): string | null {
  if (argv[0] !== 'run') return null;
  return '[biomcp] note: "run" is the invocation of the old Python BioMCP - this TypeScript package starts its MCP stdio server directly with no arguments (humans/agents: use `doctor`; see docs/AGENT-INSTALL.md).';
}

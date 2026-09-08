#!/usr/bin/env node
import { parseCliArgs, serverModeNotice } from './args.js';
import { helpText } from './help.js';
import { buildDoctorReport, exitCodeFor, formatDoctorText } from './doctor.js';
import { CLIENT_IDS } from './snippets.js';
import { VERSION } from '../version.js';

/**
 * `biomcp` CLI front door — a standalone module; the MCP server entry
 * (src/server/index.ts) is untouched. Server mode hands off to the unchanged
 * pure-server bundle via a COMPUTED specifier so the bundler leaves the import
 * external and Node resolves ./bundle.js next to this file at runtime (works
 * identically from the npx cache and local install trees).
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseCliArgs(argv);

  if (parsed.command === 'help') {
    process.stdout.write(helpText());
    return;
  }

  if (parsed.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (parsed.command === 'doctor') {
    const client = CLIENT_IDS.find((c) => c === parsed.client);
    const report = buildDoctorReport(process.cwd(), client);
    process.stdout.write(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctorText(report)}\n`);
    process.exitCode = exitCodeFor(report);
    return;
  }

  if (parsed.command === 'remote') {
    if (parsed.subcommand === 'caddyfile') {
      const { generateCaddyfile } = await import('./templates/caddyfile.js');
      process.stdout.write(generateCaddyfile({ domain: parsed.domain, port: parsed.port }));
      return;
    }
    if (parsed.subcommand === 'systemd') {
      const { generateSystemdService } = await import('./templates/systemd.js');
      process.stdout.write(
        generateSystemdService({
          user: parsed.user,
          host: parsed.host,
          port: parsed.port,
        }),
      );
      return;
    }
    console.error('Unknown remote subcommand. Available: caddyfile, systemd');
    process.exitCode = 1;
    return;
  }

  if (parsed.command === 'serve') {
    const serveOptions = {
      host: parsed.host,
      port: parsed.port,
      authTokens: parsed.token,
      traceEnabled: parsed.trace,
      traceFile: parsed.traceFile,
      insecureNoAuth: parsed.insecureNoAuth,
    };

    try {
      const remoteEntry = new URL('./remote.js', import.meta.url).href;
      const { runServe } = (await import(remoteEntry)) as { runServe: (opts: typeof serveOptions) => Promise<void> };
      await runServe(serveOptions);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') {
        const { runServe } = await import('./serve.js');
        await runServe(serveOptions);
      } else {
        throw error;
      }
    }
    return;
  }

  if (parsed.command === 'daemon') {
    const { startDaemon, stopDaemon, statusDaemon, restartDaemon } = await import('./daemon.js');
    const cliPath = process.argv[1];
    const daemonOptions = {
      host: parsed.host,
      port: parsed.port,
      token: parsed.token,
      trace: parsed.trace,
      traceFile: parsed.traceFile,
      insecureNoAuth: parsed.insecureNoAuth,
    };

    if (parsed.subcommand === 'start') {
      await startDaemon(cliPath, daemonOptions);
      return;
    }
    if (parsed.subcommand === 'stop') {
      await stopDaemon();
      return;
    }
    if (parsed.subcommand === 'status') {
      await statusDaemon();
      return;
    }
    if (parsed.subcommand === 'restart') {
      await restartDaemon(cliPath, daemonOptions);
      return;
    }
    console.error('Usage: biomcp daemon start|stop|status|restart');
    process.exitCode = 1;
    return;
  }

  // server mode (bare invocation or unrecognized args — back-compat)
  const notice = serverModeNotice(argv);
  if (notice) process.stderr.write(notice + '\n');
  const serverEntry = new URL('./bundle.js', import.meta.url).href;
  try {
    await import(serverEntry);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ENOENT') {
      console.error('biomcp: server bundle not found next to the CLI — run `npm run build` first.');
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error('biomcp cli error:', error);
  process.exitCode = 1;
});

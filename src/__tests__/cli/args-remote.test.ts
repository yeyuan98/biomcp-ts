import { describe, expect, it } from '@jest/globals';
import { parseCliArgs } from '../../cli/args.js';

describe('CLI remote & daemon arguments', () => {
  it('parses biomcp serve with flags', () => {
    const parsed = parseCliArgs(['serve', '--port', '8080', '--host', '0.0.0.0', '--token', 'secret', '--trace']);
    expect(parsed.command).toBe('serve');
    expect(parsed.port).toBe(8080);
    expect(parsed.host).toBe('0.0.0.0');
    expect(parsed.token).toBe('secret');
    expect(parsed.trace).toBe(true);
  });

  it('parses biomcp daemon subcommands', () => {
    const start = parseCliArgs(['daemon', 'start', '--port', '4000']);
    expect(start.command).toBe('daemon');
    expect(start.subcommand).toBe('start');
    expect(start.port).toBe(4000);

    const stop = parseCliArgs(['daemon', 'stop']);
    expect(stop.command).toBe('daemon');
    expect(stop.subcommand).toBe('stop');

    const status = parseCliArgs(['daemon', 'status']);
    expect(status.command).toBe('daemon');
    expect(status.subcommand).toBe('status');
  });

  it('parses biomcp remote caddyfile and systemd', () => {
    const caddy = parseCliArgs(['remote', 'caddyfile', '--domain', 'my.domain.com', '--port', '3000']);
    expect(caddy.command).toBe('remote');
    expect(caddy.subcommand).toBe('caddyfile');
    expect(caddy.domain).toBe('my.domain.com');
    expect(caddy.port).toBe(3000);

    const systemd = parseCliArgs(['remote', 'systemd', '--user', 'mcpuser']);
    expect(systemd.command).toBe('remote');
    expect(systemd.subcommand).toBe('systemd');
    expect(systemd.user).toBe('mcpuser');
  });

  it('falls back to server mode (stdio) for bare invocation or unknown commands', () => {
    expect(parseCliArgs([]).command).toBe('server');
    expect(parseCliArgs(['unknown-command']).command).toBe('server');
    expect(parseCliArgs(['some', 'stray', 'args']).command).toBe('server');
  });
});

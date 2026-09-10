/** Single source of the `biomcp --help` text. */

export function helpText(): string {
  return `biomcp — biomedical MCP server (TypeScript)

Usage:
  biomcp                start the MCP stdio server (this is what MCP clients run)
  biomcp serve [--port <p>] [--host <h>] [--token <t>] [--trace]
                        run self-hosted Streamable HTTP server in foreground
  biomcp daemon start|stop|status|restart
                        manage background self-hosted daemon process
  biomcp remote caddyfile|systemd
                        generate deployment templates for Caddy or systemd
  biomcp doctor [--json] [--client opencode|claude-code|claude-desktop|codex]
                        diagnose this installation: Node version, .biomcp.json health,
                        feature gates, peer dependencies (webr/mysql2). Exit 1 on blockers.
  biomcp version [--json]
                        print the version (aliases: --version, -v)
  biomcp --help         this help

To connect an MCP client, see docs/AGENT-INSTALL.md:
https://github.com/yeyuan98/biomcp-ts/blob/main/docs/AGENT-INSTALL.md
`;
}

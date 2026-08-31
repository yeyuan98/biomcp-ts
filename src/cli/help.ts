/** Single source of the `biomcp --help` text. */

export function helpText(): string {
  return `biomcp — biomedical MCP server (TypeScript)

Usage:
  biomcp                start the MCP stdio server (this is what MCP clients run)
  biomcp doctor [--json] [--client opencode|claude-code|claude-desktop|codex]
                        diagnose this installation: Node version, .biomcp.json health,
                        feature gates, peer dependencies (webr/mysql2). Exit 1 on blockers.
  biomcp --version      print the version
  biomcp --help         this help

To connect an MCP client, see docs/AGENT-INSTALL.md:
https://github.com/yeyuan98/biomcp-ts/blob/main/docs/AGENT-INSTALL.md
`;
}

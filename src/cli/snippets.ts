/**
 * Paste-ready MCP client entries for a chosen invocation form. Values in the
 * environment block are ALWAYS placeholders — the CLI never echoes env values.
 */

export type ClientId = 'opencode' | 'claude-code' | 'claude-desktop' | 'codex';

export const CLIENT_IDS: readonly ClientId[] = ['opencode', 'claude-code', 'claude-desktop', 'codex'];

export interface ClientSnippet {
  client: ClientId;
  label: string;
  snippet: string;
}

const SERVER_NAME = 'biomcp';

export function clientSnippets(
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  client?: ClientId
): ClientSnippet[] {
  const cmd = [...command];
  const envEntries = Object.entries(environment);
  const all: ClientSnippet[] = [
    {
      client: 'opencode',
      label: 'opencode.json (project root or ~/.config/opencode/opencode.json)',
      snippet: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            [SERVER_NAME]: {
              type: 'local',
              command: cmd,
              environment: Object.fromEntries(envEntries.map(([k]) => [k, '<set-in-your-client>'])),
              enabled: true,
              timeout: 30000,
            },
          },
        },
        null,
        2
      ),
    },
    {
      client: 'claude-code',
      label: 'Claude Code CLI (add env vars with more --env KEY=value flags)',
      snippet:
        `claude mcp add --scope user --transport stdio ${SERVER_NAME} -- ${cmd.join(' ')}` +
        envEntries.map(([k]) => ` --env ${k}=<set-in-your-client>`).join(''),
    },
    {
      client: 'claude-desktop',
      label: 'claude_desktop_config.json (macOS: ~/Library/Application Support/Claude/, Windows: %APPDATA%\\Claude\\)',
      snippet: JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              command: cmd[0],
              args: cmd.slice(1),
              env: Object.fromEntries(envEntries.map(([k]) => [k, '<set-in-your-client>'])),
            },
          },
        },
        null,
        2
      ),
    },
    {
      client: 'codex',
      label: '~/.codex/config.toml',
      snippet:
        `[mcp_servers.${SERVER_NAME}]\ncommand = "${cmd[0]}"\nargs = [${cmd
          .slice(1)
          .map((a) => JSON.stringify(a))
          .join(', ')}]` +
        (envEntries.length > 0
          ? `\n\n[mcp_servers.${SERVER_NAME}.env]\n${envEntries.map(([k]) => `${k} = "<set-in-your-client>"`).join('\n')}`
          : ''),
    },
  ];
  if (client) return all.filter((s) => s.client === client);
  // default: the two most common clients + a pointer to the rest
  return [...all.filter((s) => s.client === 'opencode' || s.client === 'claude-code'), {
    client: 'claude-desktop',
    label: 'other clients (claude-desktop, codex)',
    snippet: 'Re-run with --client claude-desktop|codex for those entry formats (see docs/AGENT-INSTALL.md §2).',
  }];
}

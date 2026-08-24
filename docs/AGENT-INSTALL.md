# Installing BioMCP (agent-friendly guide)

This document is written so a human **or an AI agent** can install and configure BioMCP end-to-end: pick an invocation path, edit the right client config file, decide on API keys and optional features, then verify.

BioMCP is a standard MCP **stdio** server — any MCP-compatible client can run it.

---

## 0. Prerequisites

- **Node.js >= 22.13** (`node --version` to check) — required for the built-in SQLite module used by the optional database feature
- `npm` / `npx`

## 1. Choose the invocation path

**Published package (recommended):**

```bash
npx biomcp          # runs the latest published server; nothing else needed
```

**From source** (only if you need unreleased changes):

```bash
git clone https://github.com/yeyuan98/biomcp-ts.git && cd biomcp-ts
npm install && npm run build     # produces dist/bundle.js
# then use: node /absolute/path/to/biomcp-ts/dist/bundle.js
```

In the snippets below, replace the `command`/`args` pair accordingly:

| Path | command | args |
|------|---------|------|
| Published | `npx` | `["biomcp"]` |
| From source | `node` | `["/absolute/path/to/biomcp-ts/dist/bundle.js"]` |

## 2. Configure your client

Pick your client, add the entry, then continue to step 3 for env vars.

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "npx",
      "args": ["biomcp"],
      "env": {}
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code

CLI (recommended):

```bash
claude mcp add --scope user --transport stdio biomcp -- npx biomcp
```

Add keys later with `--env KEY=value …` (re-run `claude mcp remove biomcp` first), or edit `.mcp.json` at the project root instead:

```json
{
  "mcpServers": {
    "biomcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["biomcp"],
      "env": {}
    }
  }
}
```

Claude Code supports `${VAR}` expansion inside `env`, so secrets can stay out of the committed file.

### Codex CLI

```bash
codex mcp add biomcp -- npx biomcp
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.biomcp]
command = "npx"
args = ["biomcp"]

[mcp_servers.biomcp.env]
# NCBI_API_KEY = "…"
```

### OpenCode

Edit `opencode.json` (project root or `~/.config/opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "biomcp": {
      "type": "local",
      "command": ["npx", "biomcp"],
      "environment": {},
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

> OpenCode specifics: `command` must be an **array**, env vars go under **`environment`** (not `env`), and a raised `timeout` avoids false failures while `npx` downloads on first run.

## 3. Decide on API keys and optional features

Work through this checklist with the user before filling in `env` blocks:

1. **Does the user hit rate limits or need premium data?** Add the matching optional keys — see [ENV-VARS.md](ENV-VARS.md#api-keys-and-identifiers) for every key and what it unlocks:
   - Higher limits: `NCBI_API_KEY`, `S2_API_KEY`, `OPENFDA_API_KEY`, `CROSSREF_EMAIL` (+`NCBI_EMAIL`)
   - Feature-gated tools/sources: `ONCOKB_TOKEN` (`variant_oncokb`), `DISGENET_API_KEY`, `EPO_OPS_CONSUMER_KEY`+`SECRET` (worldwide patents), `USPTO_API_KEY`
2. **Does the user want SQL database access?** Set `DB_TYPE=mysql` or `DB_TYPE=sqlite` plus connection variables — full guide in [DATABASE.md](DATABASE.md). Without `DB_TYPE` the db tools simply don't appear.
3. **Behind a corporate proxy?** Set `HTTPS_PROXY`/`HTTP_PROXY` (+ optional `NO_PROXY`) — see [ENV-VARS.md → Proxy](ENV-VARS.md#proxy).

Place chosen variables into the client entry's env block:

- Claude Desktop / Claude Code `.mcp.json`: `"env": { "NCBI_API_KEY": "…" }`
- Claude Code CLI: append `--env NCBI_API_KEY=…`
- Codex: `[mcp_servers.biomcp.env]` table
- OpenCode: `"environment": { "NCBI_API_KEY": "…" }`

## 4. Verify

1. Restart/reload the client.
2. Claude Code: `/mcp` or `claude mcp list` · OpenCode: `opencode mcp list` · Codex: `/mcp` inside a session.
3. Smoke-test from the terminal (server should start and wait silently on stdio):

   ```bash
   npx biomcp            # starts and idles — Ctrl+C to exit
   ```

4. In the client, ask for something like *"search genes for BRAF"* — `gene_search` should return results.

If the server starts but tool calls fail with missing-variable hints, revisit step 3.

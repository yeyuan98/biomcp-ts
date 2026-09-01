# Installing BioMCP (agent-friendly guide)

This document is written so a human **or an AI agent** can install and configure BioMCP end-to-end: add it to an MCP client, pick the right invocation form, decide on API keys and optional features, then verify — with `biomcp doctor` as the one diagnostic for everything.

> **What is this?** BioMCP-TS is a TypeScript biomedical MCP server (npm package **`biomcp`**: genes, variants, trials, literature, patents, optional R analysis). CLI subcommands from the similarly-named Python/Rust BioMCP (`biomcp serve`, `biomcp search …`) do not exist here — bare `biomcp` starts the MCP stdio server; the only CLI surface is `--help` / `--version` / `doctor`, and features are enabled with environment variables or a config file.

BioMCP is a standard MCP **stdio** server — any MCP-compatible client can run it.

---

## 0. Prerequisites

- **Node.js >= 22.13** — required for the built-in SQLite module and the optional R analysis feature (which additionally expects ~2 GB of RAM)
- `npm` / `npx`

`biomcp doctor` checks all of this for you (§3).

## 1. One-minute start

1. Pick the client entry for your MCP client from §2 and paste it.
2. Restart the client (table in §2).
3. Verify with `npx -y biomcp@0.9 doctor` — **exit 0 means you are clear**; exit 1 means read the blockers (each has a `fix_command`).
4. In the client, ask something like *"search genes for BRAF"* — `gene_search` should return results.

> Why doctor first: `npx biomcp` with no arguments starts the MCP stdio server and idles silently — in a terminal this looks like a hang. Only MCP clients should launch the bare command; humans and agents should use `--help`, `--version`, or `doctor`.

## 2. Add biomcp to your client

Three forms, one rule: **the npx cache cannot see peer dependencies, so every feature you enable must be carried as a `-p` flag in the client command.**

**All-features (recommended default)** — core tools + R analysis + MySQL, inert extras if you never use them:

```json
["npx", "-y", "-p", "biomcp@0.9", "-p", "webr@0.6", "-p", "mysql2@3", "biomcp"]
```

**Core + R** (no MySQL):

```json
["npx", "-y", "-p", "biomcp@0.9", "-p", "webr@0.6", "biomcp"]
```

**Minimal (core tools only)** — pinned, still patch-updated:

```json
["npx", "-y", "-p", "biomcp@0.9", "biomcp"]
```

Never use bare `["npx", "biomcp"]` (no pin, no peers) — see the failure table in §5. The pins get patch updates automatically; bump the minor number to upgrade (§5).

### Claude Code

CLI (recommended):

```bash
claude mcp add --scope user --transport stdio biomcp -- npx -y -p biomcp@0.9 -p webr@0.6 -p mysql2@3 biomcp
```

Add keys later with `--env KEY=value …`, or edit `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "biomcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "biomcp@0.9", "-p", "webr@0.6", "-p", "mysql2@3", "biomcp"],
      "env": {}
    }
  }
}
```

Claude Code supports `${VAR}` expansion inside `env`, so secrets can stay out of the committed file.

### OpenCode

Edit `opencode.json` (project root or `~/.config/opencode/opencode.json`); `opencode mcp add biomcp` also works but prompts interactively for local servers, so the file is simpler:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "biomcp": {
      "type": "local",
      "command": ["npx", "-y", "-p", "biomcp@0.9", "-p", "webr@0.6", "-p", "mysql2@3", "biomcp"],
      "environment": {},
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

> OpenCode specifics: `command` must be an **array**, env vars go under **`environment`** (not `env`), and `timeout` needs two values: `120000` as shown (required once R analysis is enabled — the first cold analysis runs minutes); `30000` suffices if you never enable it. Verify with `opencode mcp list`.

### Codex CLI

```bash
codex mcp add biomcp -- npx -y -p biomcp@0.9 -p webr@0.6 -p mysql2@3 biomcp
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.biomcp]
command = "npx"
args = ["-y", "-p", "biomcp@0.9", "-p", "webr@0.6", "-p", "mysql2@3", "biomcp"]

[mcp_servers.biomcp.env]
# NCBI_API_KEY = "…"
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "npx",
      "args": ["-y", "-p", "biomcp@0.9", "-p", "webr@0.6", "-p", "mysql2@3", "biomcp"],
      "env": {}
    }
  }
}
```

### Windows

MCP clients spawn `command` **without a shell**, and on Windows `npx` is a `.cmd` shim, so JSON configs need:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "-p", "biomcp@0.9", "-p", "webr@0.6", "-p", "mysql2@3", "biomcp"]
}
```

In PowerShell, quote the arguments of `claude mcp add biomcp -- …` individually if the one-liner misbehaves.

### Restart (config changes never apply live)

MCP servers launch when the client starts, so any config edit needs:

| Client | How to restart / verify |
|--------|------------------------|
| Claude Desktop | quit fully and relaunch the app |
| Claude Code | start a new session (`claude mcp list` reads fresh state; `/mcp` in-session shows startup state) |
| Codex CLI / IDE extension | exit and relaunch `codex` |
| OpenCode | restart the TUI or open a new session (`opencode mcp list`) |

## 3. Diagnose anything: `biomcp doctor`

```bash
npx -y biomcp@0.9 doctor            # human-readable, exit 1 on blockers
npx -y biomcp@0.9 doctor --json     # machine-readable (schema_version: 1)
```

Doctor reports: Node version vs the engines gate, install mode (`npx-cache` / `local-tree` / `from-source`) with mode-specific advice, `.biomcp.json` health (parse/schema/security refusals), which features would be ON after a restart, peer-dependency resolvability (`webr`, `mysql2`), env-var presence (masked), RAM warning, and structured blockers `{code, message, fix_command}`. Its paste-ready client snippets are always version-pinned and include the `-p` flag for **every** feature that will be ON after restart (file- or env-enabled alike) — trust them over hand-written commands.

**Doctor diagnoses THIS invocation, not your client's.** To reproduce what the client runs, launch doctor exactly like the client does — same command array, same env block:

```bash
ANALYSIS_R=1 npx -y -p biomcp@0.9 -p webr@0.6 biomcp doctor
```

Agents: add `--client opencode|claude-code|claude-desktop|codex` to get that client's paste-ready entry in `next_steps`.

## 4. Optional features

Work through this checklist with the user before filling in env blocks. Once biomcp is connected, the `biomcp_configure` tool can do most of this for you (it writes `.biomcp.json` in the project directory and validates): call it with `{}` for a status overview, then `{"action":"set","values":{"features.<group>.<key>":…}}`. Env-only parameters (API keys, proxy, security boundaries) remain query-only there — see [ENV-VARS.md](ENV-VARS.md).

> **Sensitive keys:** the first `set` of a sensitive/secret key (`mirror_url`, `github_repo`, `sqlite_path`, `host`, `user`, `database`, `password` — full list in [ENV-VARS.md](ENV-VARS.md#project-config-file-biomcpjson-alternative-to-env-blocks)) is refused by design; re-send the identical call with `"confirm_sensitive": true` added. The refusal message says so too.

### A. Biowasm analysis (samtools/bedtools/bcftools over BAM/BED/VCF)

The simplest feature — **npx-only, nothing to install**:

1. Set `ANALYSIS_BIOWASM=1` in the client env block (`environment` for OpenCode, `env` for Claude/Codex).
2. To read host files, also set `ANALYSIS_BIOWASM_DATA_DIR` to the allowlisted directory (unset = host files denied).
3. Restart; verify with the `analysis_biowasm_session_info` tool (first use downloads ~4.5 MB of wasm assets, cached in `~/.cache/biomcp/`).

Full guide: [BIOWASM-ANALYSIS.md](BIOWASM-ANALYSIS.md).

### B. R/Bioconductor analysis (DESeq2, edgeR, limma)

1. Use a §2 command that carries `-p webr@0.6` (the all-features or core+R form) — this is the whole install; there is no separate step.
2. Set `ANALYSIS_R=1` in the client env block (or enable via `biomcp_configure`, which writes the config file).
3. Restart; verify with the `analysis_r_session_info` tool.

**Cold-start expectations (read before the first analysis):** the first R tool call starts a ~1 GB WebAssembly R worker and downloads the wasm package bundle (~62 MB) from GitHub releases into `~/.cache/biomcp/` — **minutes, not seconds**. Raise the client `timeout` (OpenCode: `120000`) or pre-warm once from bash before asking the client. Later calls reuse the warm worker (seconds).

If the ~62 MB download aborts on a slow link, two documented ways out:

- Raise the limit: `{"action":"set","values":{"features.analysis_r.asset_timeout_ms":1800000}}` (default 600000 ms, max 3600000), restart, retry; or
- Self-fetch the bundle and serve it locally:

```bash
gh release download -R yeyuan98/biomcp-ts -p 'r-wasm-mirror-*.tar.gz' -O ~/biomcp-r-bundle.tar.gz   # latest release
```
```json
{"action":"set","values":{"features.analysis_r.mirror_url":"/absolute/path/to/biomcp-r-bundle.tar.gz"},"confirm_sensitive":true}
```
(Use the archive's absolute path — file keys do no `~` expansion.) Then restart the client. Equivalent env var: `ANALYSIS_R_MIRROR_URL`.

Alternative (air-gapped / version-pinned trees): build a local tree, then point the client at the **absolute** bundle path — clients control the server's working directory, so "run from the tree" never reaches the server:

```bash
mkdir biomcp-r && cd biomcp-r && npm install biomcp webr
# client command array:
["node", "<ABSOLUTE_PATH>/biomcp-r/node_modules/biomcp/dist/bundle.js"]
```

Full guide: [R-ANALYSIS.md](R-ANALYSIS.md).

### C. SQL database access — SQLite

Zero dependencies (built-in `node:sqlite`). Either set `DB_TYPE=sqlite` + `DB_SQLITE_PATH=<file>` in the env block, or — after restart — use the `biomcp_configure` tool, which writes and validates the config file for you. Full guide: [DATABASE.md](DATABASE.md).

### D. SQL database access — MySQL

Same pattern as R analysis: the `mysql2` driver is a peer dependency.

1. Use a §2 command that carries `-p mysql2@3` — the all-features form already does; the MySQL-only variant is `["npx", "-y", "-p", "biomcp@0.9", "-p", "mysql2@3", "biomcp"]` — or the local-tree + absolute-path alternative shown in §B with `npm install biomcp mysql2`.
2. Set `DB_TYPE=mysql` + `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_DATABASE` in the env block (or via `biomcp_configure`).
3. Restart; verify with `db_list_tables`.

### E. API keys & proxy

Optional keys raise rate limits or unlock premium sources (`NCBI_API_KEY`, `S2_API_KEY`, `OPENFDA_API_KEY`, `CROSSREF_EMAIL`, `ONCOKB_TOKEN`, `DISGENET_API_KEY`, `EPO_OPS_*`, `USPTO_API_KEY`). Corporate proxy: `HTTPS_PROXY`/`HTTP_PROXY` (+ `NO_PROXY`). Every key, what it unlocks, and where to put it: [ENV-VARS.md](ENV-VARS.md#api-keys-and-identifiers).

## 5. Verify & troubleshoot

1. Restart per the §2 table.
2. Client listing: Claude Code `/mcp` or `claude mcp list` · OpenCode `opencode mcp list` · Codex `/mcp` in-session.
3. `npx -y biomcp@0.9 doctor` — exit 0 = healthy; read blockers otherwise. **Doctor already proves the post-restart state** — `features[].running_after_restart` and `startup.applied_keys` are computed by replaying the exact startup in a fresh process — so you can *check* without restarting; restart only to *use* the tools in the client.
4. In the client: `biomcp_configure` with `{}` — confirm `features.<id>.running_now === true` for what you enabled.

**Failure table**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `npx biomcp --help` idles silently | pre-0.9 versions start the stdio server on any argv | use `biomcp doctor` / `--version`; upgrade |
| `biomcp run` prints a note, then seems to hang | retired Python-BioMCP usage; unrecognized argv still starts the stdio server (stderr note since 0.9.2) | MCP clients: spawn bare `biomcp`; humans/agents: `biomcp doctor` |
| Feature tools missing after enabling | server loaded config at startup | restart the client (§2 table) |
| `webr`/`mysql2` missing while `install_mode` is `npx-cache` | peer deps invisible to the npx cache | use a §2 command that carries the matching `-p` flag (doctor's snippet always includes every enabled feature's peer), or local tree + absolute `node …/dist/bundle.js` path |
| Command missing a peer after enabling more features | the client command was written for fewer features | copy doctor's paste-ready snippet — it unions every enabled feature's `-p` flags |
| `biomcp_configure` set refused: sensitive | sensitive/secret keys need explicit confirmation | re-send the identical call with `"confirm_sensitive": true` (§4 note) |
| R bundle download times out (`Mirror download timed out …`) | slow link vs the 10-min default | raise `features.analysis_r.asset_timeout_ms`, or self-fetch + `mirror_url` (recipe in §4B) |
| First R tool call fails client-side but machine is fine | cold bootstrap runs minutes; client `timeout` too low (e.g. OpenCode 30000) | raise the client `timeout` to 120000, or pre-warm from bash (§4B) |
| Client killed, but a node process + ~1 GB RSS lingers | the orphaned server/worker outlived an abrupt client kill | `pkill -f 'biomcp.*bundle.js'`; (fixed for new clients in 0.9.1 — the server now exits when stdin closes) |
| `cwd_refused` from `biomcp_configure` set | server cwd is `/` or `$HOME` (cwd-less client, e.g. Claude Desktop) | use the env block instead — the tool's error response carries a paste-ready translation |
| "Ok to proceed?" or timeout on first run | npx first-download under a slow network / interactive stdin | keep the raised `timeout` (OpenCode) and `-y` in the command; retry |
| Expected features absent, config looks right | stale npx cache holding an old biomcp | clear it: `rm -rf ~/.npm/_npx` (Windows: `%LocalAppData%\npm-cache\_npx`), restart |
| Upgrade | — | bump the pin in the client config (`biomcp@0.9` → new minor), restart; check `biomcp --version` |

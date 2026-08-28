# Installing BioMCP (agent-friendly guide)

This document is written so a human **or an AI agent** can install and configure BioMCP end-to-end: pick an invocation path, edit the right client config file, decide on API keys and optional features, then verify.

BioMCP is a standard MCP **stdio** server — any MCP-compatible client can run it.

---

## 0. Prerequisites

- **Node.js >= 22.13** (`node --version` to check) — required for the built-in SQLite module used by the optional database feature; the optional R analysis feature additionally expects ~2 GB of available RAM
- `npm` / `npx`

## 1. Choose the invocation path

**Published package (recommended):**

```bash
npx biomcp          # runs the latest published server; nothing else needed
```

`npx biomcp` from any directory covers the **core tools and the SQLite backend** (zero extra dependencies). The **MySQL backend additionally needs the optional driver `mysql2`**, and npm peer dependencies resolve only from a local install tree — see step 3 if you want it.

**From source** (only if you need unreleased changes):

```bash
git clone https://github.com/yeyuan98/biomcp-ts.git && cd biomcp-ts
npm install && npm run build     # produces dist/bundle.js
# then use: node /absolute/path/to/biomcp-ts/dist/bundle.js
```

In the snippets below, replace the `command`/`args` pair accordingly:

| Path | command | args | Backends available |
|------|---------|------|--------------------|
| Published (`npx`) | `npx` | `["biomcp"]` | Core + SQLite |
| Published + MySQL | `npx` | `["biomcp"]` (from the local tree created in step 3) | Core + SQLite + MySQL |
| From source | `node` | `["/absolute/path/to/biomcp-ts/dist/bundle.js"]` | Core + SQLite (+ MySQL if `mysql2` is installed in that checkout) |

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
2. **Does the user want SQL database access?** Two parts — full guide in [DATABASE.md](DATABASE.md):
   - **If MySQL:** the optional driver must be installed next to biomcp. Create a local install tree (peer dependencies are not auto-installed and cannot be seen from a bare `npx biomcp`):
     ```bash
     mkdir biomcp-mysql && cd biomcp-mysql
     npm install biomcp mysql2
     # run `npx biomcp` from this directory; point the client's command/args here
     ```
   - **If SQLite:** nothing to install (built-in `node:sqlite`); plain `npx biomcp` works.
   - Either way, set `DB_TYPE=mysql|sqlite` plus connection variables ([ENV-VARS.md](ENV-VARS.md#database-access-optional-feature)). Without `DB_TYPE` the db tools simply don't appear.
3. **Does the user want in-process R/Bioconductor analysis?** (`analysis_r_deseq2`, `analysis_r_edger`, `analysis_r_limma`, `analysis_r_session_info`) — full guide in [R-ANALYSIS.md](R-ANALYSIS.md):
   - The optional `webr` peer dependency must be installed next to biomcp (same local-install-tree pattern as MySQL):
     ```bash
     mkdir biomcp-r && cd biomcp-r
     npm install biomcp webr
     # run `npx biomcp` from this directory; point the client's command/args here
     ```
     One-shot alternative: `npx -p biomcp -p webr biomcp`.
    - Set `ANALYSIS_R=1` in the env block. First use starts a ~1 GB WebAssembly R worker and downloads the wasm package bundle (~62 MB) from GitHub releases into `~/.cache/biomcp/` (cached; offline override via `ANALYSIS_R_MIRROR_URL`).
4. **Does the user want samtools/bedtools/bcftools over BAM/BED/VCF files?** (`analysis_bam_summary`, `analysis_bam_view_region`, `analysis_bcf_summary`, `analysis_bcf_view_region`, `analysis_bed_op`, `analysis_biowasm_convert`, `analysis_biowasm_session_info`, `analysis_biowasm_cli`) — full guide in [BIOWASM-ANALYSIS.md](BIOWASM-ANALYSIS.md):
   - This is the **simplest** optional feature: set `ANALYSIS_BIOWASM=1` only — no local install tree needed (unlike `webr`/`mysql2`); the wasm assets (~4.5 MB, checksum-verified) download at first use into `~/.cache/biomcp/`.
   - To read BAM/VCF/BED files from disk, also set `ANALYSIS_BIOWASM_DATA_DIR` to the allowlisted directory (unset = host files denied).
5. **Behind a corporate proxy?** Set `HTTPS_PROXY`/`HTTP_PROXY` (+ optional `NO_PROXY`) — see [ENV-VARS.md → Proxy](ENV-VARS.md#proxy).

Place chosen variables into the client entry's env block:

- Claude Desktop / Claude Code `.mcp.json`: `"env": { "NCBI_API_KEY": "…" }`
- Claude Code CLI: append `--env NCBI_API_KEY=…`
- Codex: `[mcp_servers.biomcp.env]` table
- OpenCode: `"environment": { "NCBI_API_KEY": "…" }`

## 4. Verify

> **A restart is required to load (or reload) the biomcp tools.** MCP servers are launched when the client starts, so config edits made while a client is running do not take effect until it restarts. After any change to the server entry — adding biomcp, changing env vars, enabling the database feature — restart:
>
> - **Claude Desktop**: quit fully and relaunch the app
> - **Claude Code**: start a new session (`claude mcp list` reads fresh state; `/mcp` inside an existing session shows only what was loaded at startup)
> - **Codex CLI / IDE extension**: exit and relaunch `codex`
> - **OpenCode**: restart the TUI or open a new session

1. Restart the client per the table above.
2. Claude Code: `/mcp` or `claude mcp list` · OpenCode: `opencode mcp list` · Codex: `/mcp` inside a session.
3. Smoke-test from the terminal (server should start and wait silently on stdio):

   ```bash
   npx biomcp            # starts and idles — Ctrl+C to exit
   ```

4. In the client, ask for something like *"search genes for BRAF"* — `gene_search` should return results.

If tools still don't appear after a full restart, re-check step 2's listing command for parse warnings; if tool calls fail with missing-variable hints, revisit step 3.

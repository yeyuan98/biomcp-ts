# R Analysis (Bioconductor in WebAssembly)

Run standard bulk RNA-seq differential-expression analyses — DESeq2, edgeR, and
limma-voom — directly inside the biomcp process. R is compiled to WebAssembly
([webR](https://docs.r-wasm.org/)), so no R installation, container, or native
compilation is required; the runtime is sandboxed (no shell, no host filesystem
access).

This is an **optional feature**, enabled like database access.

## Enabling

```
ANALYSIS_R=1
```

Agents can also enable this feature themselves via the always-available `biomcp_configure` tool (`{"action":"set","values":{"features.analysis_r.enabled":true}}`, or the `.biomcp.json` file it writes) — but the `webr` peer dependency below must be resolvable from the server's own install tree, which only the invocation form can provide.
`webr` is an optional peer dependency (like `mysql2` for the database feature). The recommended form is the pinned one-shot, used **as the client's command array** — no install step:

```
npx -y -p biomcp@0.8 -p webr@0.6 biomcp   # client command array (plain argv, no shell)
```

Why not `npm install biomcp webr` in a subdirectory + bare `npx biomcp`? Node resolves peer dependencies relative to the running script's tree, and MCP clients control the server's working directory (OpenCode = its launch directory, Claude Desktop = `/`) — a tree in a subfolder is invisible. If you need a local tree (air-gapped, exact pinning), invoke it by **absolute path**:

```
mkdir biomcp-r && cd biomcp-r && npm install biomcp webr
# client command array:
["node", "<ABSOLUTE_PATH>/biomcp-r/node_modules/biomcp/dist/bundle.js"]
```

`biomcp doctor` reports your current install mode and whether `webr` resolves (see docs/AGENT-INSTALL.md §3).

### Example (Claude Desktop)

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "npx",
      "args": ["-y", "-p", "biomcp@0.8", "-p", "webr@0.6", "biomcp"],
      "env": {
        "ANALYSIS_R": "1"
      }
    }
  }
}
```

## What happens on first use

1. The webR runtime (R 4.6.0, ~50 MB inside the `webr` package) starts in a
   worker thread — expect ~1 GB RSS and a few seconds.
2. The wasm package bundle (~62 MB, the DESeq2/edgeR/limma dependency closures
   plus a self-built `locfit`) is downloaded **once** from this project's GitHub
   releases into `~/.cache/biomcp/` and checksum-verified (`manifest.json`).
   At process start the GitHub-reported asset digest is compared against the
   cache, so unchanged releases never re-download.
3. Packages install into the in-memory R library (~5 s), then the engine is
   reused for every tool call.

Offline/air-gapped use: point `ANALYSIS_R_MIRROR_URL` at a bundle directory,
`.tar.gz` archive, or self-hosted URL (see [ENV-VARS.md](ENV-VARS.md)).

## Tools

### `analysis_r_deseq2`

Negative-binomial DE via DESeq2 (`DESeq` Wald, `results`), with `alpha`,
`fit_type`, and optional built-in shrinkage (`lfcShrink(type="normal")`).

### `analysis_r_edger`

edgeR quasi-likelihood (`test="qlm"`, default) or 2-group exact test
(`test="exact"`), with `filterByExpr` + TMM normalization.

### `analysis_r_limma`

limma-voom (`voom` → `lmFit` → `eBayes` → `topTable`), with the same
filter/TMM prefix.

### `analysis_r_session_info`

Runtime report: R/webR versions, package versions, memory, mirror endpoint.

### Shared input contract

- `counts`: gene x sample **raw integer counts** — object
  `{genes, samples, matrix}` or CSV string (header row = samples, first
  column = gene IDs).
- `coldata`: per-sample metadata — `{samples, columns}` or CSV. String columns
  become factors.
- `design`: RHS formula over coldata columns (`condition`, `batch + condition`).
- `contrast` `{variable, numerator, denominator}` **or** `coef` — a model-matrix
  column name for edgeR/limma (`conditiontreated`) or a DESeq2 results name
  (`condition_treated_vs_control`; model-matrix names are auto-translated).
  Default: last term of the design.
- Output: markdown table of the top `top_n` genes by adjusted p-value plus a
  summary block (default `format="table"`); `format="json"` for structured
  output; `include_full=true` adds the complete table as
  base64(gzip(TSV)) — gunzip after base64-decode.

Limits: ≤ 50,000 genes x ≤ 64 samples; per-call timeout
(`ANALYSIS_R_TIMEOUT_MS`, default 10 min); memory watermark
(`ANALYSIS_R_MEM_LIMIT_MB`, default 2048). Analyses run serialized on one R
instance.

## Version pinning

The bundle is rebuilt only when the R-analysis sources change (release
workflow `.github/workflows/r-wasm-mirror.yml`); unrelated releases copy the
previous asset forward, so package versions stay pinned. Exact versions are
reported in every tool response and by `analysis_r_session_info`. The bundle
currently targets Bioconductor 3.24 devel built against R 4.6.0 — robustness
over cutting edge.

## Security Model

- R code executed is generated exclusively from validated inputs; no
  user-supplied R is evaluated.
- Design formulas are whitelisted (`^[A-Za-z0-9_ +*():.]+$` + token denylist)
  and only ever feed `model.matrix()`.
- The wasm sandbox has no shell and no host filesystem access. Note that R
  **does** have HTTP fetch capability inside the sandbox (that is how package
  installation works); it cannot reach host files.
- Downloads from GitHub releases are HTTPS and verified: the asset hash is compared against the GitHub-reported digest when available, and every file is checked against the bundle manifest's SHA-256 before use. This verifies **integrity and drift**; authenticity rests on HTTPS + GitHub release provenance (the manifest ships inside the same asset and is not an independent trust anchor). A user-supplied `ANALYSIS_R_MIRROR_URL` overrides the source entirely (an `http://` URL would be unauthenticated) and a plain directory is trusted as-is.

## Testing

- Unit: `src/__tests__/ranalysis/` and `src/__tests__/server/ranalysis-tools.test.ts`
  (webR mocked via `jest.unstable_mockModule`).
- Integration: `src/__tests__/integration/tools/ranalysis-tools.integration.test.ts`
  (gated — runs when a mirror is available via `ANALYSIS_R_MIRROR_URL` or the
  local cache; skips otherwise).
- Release bundle validation: `scripts/ranalysis/validate-bundle.mjs` (golden
  numeric checks; runs in the release workflow).

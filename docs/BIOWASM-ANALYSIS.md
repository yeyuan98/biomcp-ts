# Biowasm Analysis (samtools / bedtools / bcftools in WebAssembly)

Run samtools, bedtools, and bcftools directly inside the biomcp process —
alignment summaries, region queries, interval algebra, and VCF projections over
BAM/BED/VCF data at host-file scale. The tools are compiled to WebAssembly
([biowasm](https://biowasm.com/)), so no native installation, container, or
compilation is required; the runtime is sandboxed (no shell, no network, no
filesystem access outside what you explicitly allow).

This is an **optional feature**, enabled like database access.

## Enabling

```
ANALYSIS_BIOWASM=1
```

Unlike R analysis there is **no npm peer dependency** — nothing to install next
to biomcp; a plain `npx biomcp` works. The wasm assets (~4.5 MB for all three
tools) download **once** at first use into `~/.cache/biomcp/` and are
checksum-verified against dev-time SHA-256 pins.

### Example (Claude Desktop)

```json
{
  "mcpServers": {
    "biomcp": {
      "command": "npx",
      "args": ["-p", "biomcp", "biomcp"],
      "env": {
        "ANALYSIS_BIOWASM": "1"
      }
    }
  }
}
```

To read host files (BAM/VCF/BED on disk), also set
`ANALYSIS_BIOWASM_DATA_DIR` to the directory you want to allow (unset = host
paths denied; see [ENV-VARS.md](ENV-VARS.md)).

## What happens on first use

1. A `worker_threads` worker spawns (~100 ms) and loads the three pinned
   modules (samtools, bedtools, bcftools) into one shared virtual filesystem.
2. The wasm assets (~4.5 MB total) are downloaded once from the biowasm CDN
   into `~/.cache/biomcp/biowasm-<hash>/` and verified against the pinned
   SHA-256 hashes (a mismatch triggers one re-fetch, then a hard failure).
3. The engine is reused for every tool call; large inputs are never copied —
   host files are mounted lazily and read index-driven (a region query on a
   312 MB BAM touches ~0.2 % of the file).

Offline/air-gapped use: point `ANALYSIS_BIOWASM_MIRROR_URL` at a directory,
`.tar.gz` archive, or self-hosted URL holding the pinned tool files.

## Tools

### `analysis_bam_summary`

What is in this BAM? Header contigs and lengths, sample/read groups, flagstat
mapping metrics, and per-contig mapped/unmapped counts (idxstats) when an
index is available.

### `analysis_bam_view_region`

Reads, depth, or pileup in a genomic region (`view -c`/`depth`/`mpileup`), or
a BAM artifact of the reads (`view -b`) for downstream tools. Region access is
index-driven.

### `analysis_bcf_summary`

What is in this VCF/BCF? Contigs, sample count and names, and the INFO/FORMAT
field inventory from the header (no index needed).

### `analysis_bcf_view_region`

Variants in a region as a narrow field projection (`bcftools query`): chosen
columns, optional sample subset, expression filter, and variant types — or a
sliced VCF.gz artifact.

### `analysis_bed_op`

Interval algebra on BED tracks (`bedtools intersect/merge/subtract/coverage/
jaccard/sort`), with the streaming `-sorted` algorithm for sorted inputs.

### `analysis_biowasm_convert`

Format plumbing between the tools: SAM/BAM/CRAM via `samtools view`, VCF/BCF
via `bcftools view`, and VCF/BCF → TSV via `bcftools query` with a projection.
Results are artifact handles reusable as `artifact_id` inputs.

### `analysis_biowasm_session_info`

Runtime report: pinned tool versions, asset cache state, engine status,
retained artifacts, memory. Read-only; never downloads or starts anything.

### `analysis_biowasm_cli`

Constrained escape hatch: an allowlisted samtools/bedtools/bcftools subcommand
run with a schema-validated argument array (no shell). Prefer the workflow
tools above.

### Shared input contract

- `source` (how data arrives, one of):
  - `{content: "…"}` — in-band text (BED/VCF/SAM; the format is sniffed),
    capped at 20 MiB;
  - `{artifact_id: "bw…"}` — an artifact handle from a previous
    analysis_biowasm response;
  - `{host_path: "/…"}` — a host file under `ANALYSIS_BIOWASM_DATA_DIR`
    (must be set; `..` segments and anything resolving outside the root are
    rejected). Large files are lazy-mounted, never copied.
- `index` — the index sidecar: `"auto"` (default; detects
  `<file>.bai/.csi/.tbi/.crai` next to host files), `{content}` or
  `{host_path}` for an explicit sidecar. Region queries on BAM and indexed
  VCF need an index; VCF region queries fall back to streaming when absent.
- `region` — structured `{chrom, start?, end?}` (1-based inclusive); the
  engine formats the tool syntax, so no string parsing on your side. Spans
  are capped at 100 Mb.
- `projection` — `{fields, samples}` for VCF queries: chosen columns
  (`CHROM/POS/REF/ALT/…/GT`, default `CHROM,POS,REF,ALT`) and an optional
  sample subset — strongly recommended for cohort-scale VCFs (the #1
  context-reduction lever on 2504-sample files).
- Output policy (`format` / `top_n` / `include_content`): `table` renders a
  markdown table of the first `top_n` rows (≤ 200) under a 2 MB cap;
  `json` returns the same data structured; `artifact` (where the tool supports
  file output) returns an artifact handle — id, host path, size, sha256, and a
  ≤ 2 KB preview — reusable as `source.artifact_id`. `include_content=true`
  additionally inlines artifacts ≤ 2 MB as base64(gzip).
- Every response embeds `io_stats` (bytes read, elapsed) for cost reasoning.

Limits: region span ≤ 100 Mb; text output ≤ 2 MB (`is_truncated` when
clipped); in-band content ≤ 20 MiB; artifacts retained: 200 (LRU-evicted);
per-call timeout `ANALYSIS_BIOWASM_TIMEOUT_MS` (default 10 min); memory
watermark `ANALYSIS_BIOWASM_MEM_LIMIT_MB` (default 2048); per-run output byte
budget 2 GB. bedtools loads the B track into the wasm heap unless
`sorted_inputs` is set — prefer sorted or bounded B tracks. bcftools is
pinned at 1.10 (CDN availability; newer subcommands may be absent). Runs
serialize on one worker; CRAM without an embedded reference needs a `faidx`
reference. wasm builds historically lose exit statuses: the biowasm glue's
`callMain` swallows the Emscripten `ExitStatus` on every path, so failures
used to render as `exit code 0`. biomcp recovers real statuses by calling the
module's `_main` directly (glue-compatible argv, status-propagating) and, for
builds that exit 0 after a fatal error, falls back to fatal-stderr pattern
matching (`[E::…]`, `samtools <cmd>: …`, `[main_…]`); `[W::…]` warnings and
`[mpileup] N samples…` INFO lines are treated as benign. `analysis_biowasm_cli`
never throws — it renders `exit_code` and an `is_error` flag honestly.

## Version pinning

Tool versions and per-file SHA-256 hashes are pinned at dev time
(`scripts/biowasm/pin-assets.mjs`): samtools 1.21, bedtools 2.31.0, bcftools
1.10. Downloads are verified against the pins (one re-fetch on mismatch, then
a hard failure with re-pinning guidance); a cached, state-file-verified asset
set is never re-downloaded. `ANALYSIS_BIOWASM_MIRROR_URL` overrides the
source entirely (a `.tar.gz` is extracted and pin-verified; a plain directory
is trusted as-is) — mirroring `ANALYSIS_R_MIRROR_URL` semantics. Default CDN
provenance avoids redistribution-licensing questions (bedtools is GPL-2.0).

## Security Model

- The wasm sandbox has no shell and no network access (no socket support is
  compiled in); tools see only the virtual filesystem under `/shared`.
- Host-file reads require `ANALYSIS_BIOWASM_DATA_DIR`; every path is
  resolved and prefix-checked **after normalization** (embedded `..` and
  prefix-sibling bypasses are rejected). Default is deny.
- bcftools expressions are length-capped and denylisted (`;`, backtick, `$`,
  and `system`/`exec`/`eval` tokens); the engine composes `query -f` strings
  only from enumerated fields, never free text.
- `analysis_biowasm_cli` passes args as an array straight to `callMain` —
  never through a shell; subcommands are allowlisted, metacharacters and
  `..` are rejected, and paths must live under `/shared`.
- Tool writes stream to the host artifacts cache under a byte budget; outputs
  over budget fail cleanly instead of exhausting the wasm heap.

## Testing

- Unit: `src/__tests__/biowasm/` (schemas, validation/sandbox, artifact
  registry) and `src/__tests__/server/biowasm-tools.test.ts` (MCP layer;
  engine mocked via `jest.unstable_mockModule`).
- Integration: `src/__tests__/integration/tools/biowasm-engine.integration.test.ts`
  and `biowasm-tools.integration.test.ts` (gated — run when a mirror is
  configured via `ANALYSIS_BIOWASM_MIRROR_URL` or the asset cache is already
  populated; skip otherwise).

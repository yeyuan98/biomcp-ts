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

Agents can also enable this feature via the always-available `biomcp_configure` tool (`{"action":"set","values":{"features.analysis_biowasm.enabled":true}}`, or the `.biomcp.json` file it writes). Note that `ANALYSIS_BIOWASM_DATA_DIR` — the host-path allowlist — is deliberately env-only and cannot be set through the file/tool.
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
index is available. Large host inputs are estimate-gated: when the full
flagstat stream is estimated to exceed ~45 s the tool returns guidance
instead — re-run with `proceed_on_large_input=true` to stream anyway (see
"Performance envelope and protocol semantics" below).

### `analysis_bam_view_region`

Reads, depth, or pileup in a genomic region (`view -c`/`depth`/`mpileup`), or
a BAM artifact of the reads (`view -b`) for downstream tools. Indexed sources
(host file + sibling `.bai`/`.crai`) use fast positional retrieval; indexless
sources stream through a synthesized BED region filter (`-L`/`-b`/`-l`).

Sortedness contract for the indexless fallback: `count`/`reads` accept any read
order, but `depth` requires coordinate-sorted input — samtools `depth -a`
silently emits doubled, self-contradictory output (a zero-filled pass followed
by the real pass) when read order regresses across references, so the analyzer
detects that signature (a repeated `(chrom, pos)` row, impossible on valid
single-interval output) and fails with an actionable error (provide an index,
re-sort via `analysis_biowasm_cli`, or use count/reads). Limitation: a region
large enough to hit the 2 MB capture cap before the doubled section can hide
the duplicate, leaving flagged (`is_truncated`) output. `pileup` also assumes
sorted input.

### Worker pool (`ANALYSIS_BIOWASM_WORKERS`)

The engine is a pool of serialized workers. With the default `1` every run
serializes exactly as before; set `ANALYSIS_BIOWASM_WORKERS=N` (≥ 1) and
**concurrent tool calls execute in parallel** on N single-threaded wasm
workers — one long VCF stream no longer blocks the other calls (each worker
runs its own copy of the tools with its own virtual filesystem; host inputs
are mounted read-only per worker, so parallel mounts of the same file are
safe). Extra workers spawn lazily: a call that would queue while every
existing worker is busy reserves one more (up to N) and awaits its ~2–3 s
bootstrap; a spawn failure is remembered — no retry storms — and the call
queues instead. Cancellation, timeouts, and crashes isolate to their own
worker (the rest of the pool keeps running); artifact ids are pool-global
(they resolve to host files). Progress stays per-call. Memory: each worker
carries its own V8 heap (capped at 2 GB) plus wasm linear memory, and
`ANALYSIS_BIOWASM_MEM_LIMIT_MB` is a whole-process watermark covering the
pool — size N with `N × ~2 GB` comfortably inside your budget.
`analysis_biowasm_session_info` reports the pool status (configured / alive /
busy). The wasm builds themselves are single-threaded (no pthreads), so a
single call's throughput never changes — the pool buys concurrency across
calls.

### `analysis_bcf_summary`

What is in this VCF/BCF? Variant record count — instantly from the index when
the sidecar carries per-contig counts (see the index fast path below), else a
gated streaming count — contigs, sample count and names, and the INFO/FORMAT
field inventory from the header (no index needed). Sample-dense host files
are estimate-gated: when the streaming count is estimated to exceed ~45 s the
tool returns guidance instead — re-run with `proceed_on_large_input=true` to
stream anyway (progress will be reported).

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
run timeouts `ANALYSIS_BIOWASM_TIMEOUT_MS` (inactivity deadline, default
10 min) and `ANALYSIS_BIOWASM_MAX_RUN_MS` (absolute ceiling, default 1 h —
both under "Run timeouts" below); memory
watermark `ANALYSIS_BIOWASM_MEM_LIMIT_MB` (default 2048); per-run output byte
budget 2 GB. bedtools loads the B track into the wasm heap unless
`sorted_inputs` is set — prefer sorted or bounded B tracks. bcftools is
pinned at 1.10 (CDN availability; newer subcommands may be absent). Runs
serialize per worker (`ANALYSIS_BIOWASM_WORKERS`, default 1; see "Worker
pool" above); CRAM without an embedded reference needs a `faidx`
reference. wasm builds historically lose exit statuses: the biowasm glue's
`callMain` swallows the Emscripten `ExitStatus` on every path, so failures
used to render as `exit code 0`. biomcp recovers real statuses by calling the
module's `_main` directly (glue-compatible argv, status-propagating) and, for
builds that exit 0 after a fatal error, falls back to fatal-stderr pattern
matching (`[E::…]`, `samtools <cmd>: …`, `[main_…]`); `[W::…]` warnings and
`[mpileup] N samples…` INFO lines are treated as benign. `analysis_biowasm_cli`
never throws — it renders `exit_code` and an `is_error` flag honestly.

## Performance envelope and protocol semantics

### Measured throughput envelope

All numbers measured on the development host with the pinned wasm builds and
the 1000 Genomes twins used by the agent-test suite:

| Operation class | Example | Measured |
|---|---|---|
| Indexed region query | BAM region query via `.bai` | touches ~0.2 % of file bytes (lazy fd-backed mounts) |
| Header / index metadata | `bcftools view -h` on a 206 MB VCF | 0.12 s (13 KB output) |
| BAM full-stream | `samtools view -c` over 311 MB | ~110 MB/s (2.9 s) |
| Dense-VCF full-stream | `bcftools view -H` count over 206 MB, 2,504 samples | ~0.9 MB/s (228 s; ~11 GB of expanded text) |

The only legitimately slow class is the full-stream parse of sample-dense
VCFs — text expansion is linear in sample count, so a 2 GB cohort file
extrapolates to ~35–40 min. Everything else, orientation included, is
seconds or less. MCP clients, however, impose their own deadlines: opencode,
for instance, aborts a silent tool call at 60 s (then sends
`notifications/cancelled`) but keeps waiting while progress notifications
arrive — the same 100 s probe failed at 60.0 s when silent and completed at
100.1 s when reporting every 5 s. The mechanisms below exist because of that
gap; none of them change the lazy-mounted, never-copied input model.

### Progress notifications

- Emitted only when the client supplies a `_meta.progressToken`; tokenless
  clients get silence and behavior is unchanged.
- Payload is bytes-based: `progress` is the cumulative number of bytes read
  (monotonic across an analyzer's sequential engine runs, so multi-run tools
  report valid MCP progress); against the pre-flight file size it reads as a
  fraction of the total.
- Cadence is at least 5 s (throttled worker-side; the first message always
  emits). Pure-compute phases with zero I/O emit nothing — coherent with the
  activity-based timeout below, and the streaming parsers that need progress
  read continuously.
- `message` carries elapsed time plus a short stderr tail, so a stuck run is
  diagnosable from the client log.

### Cancellation

A client cancel — or the client's own timeout firing — frees the engine
immediately instead of leaving a zombie run blocking the serialized queue:

- Queued runs reject before starting ("cancelled before start").
- Running runs: the worker is killed through the existing watchdog cancel
  path and the request resolves as cancelled (`BiowasmCancelledError`
  surfaces as a clear isError result). Disk artifacts and source indexes
  persist; the engine's in-memory artifact map is cleared and a fresh
  worker respawns on the next call (tool re-init ~2–3 s) — the same
  recovery as the timeout path.

### Large-input estimate gate

`analysis_bam_summary` and `analysis_bcf_summary` — and only those two —
full-stream a mounted host file as part of their work. Before doing so they
estimate the streaming time with a documented heuristic built from the
measured envelope above:

- BAM-class ≈ 110 MB/s.
- VCF-class ≈ 0.9 MB/s × 2504/sampleCount, clamped to [0.9, 110] MB/s. The
  sample count is sniffed from the header read (0.12 s on the 206 MB twin);
  a failed sniff assumes the dense worst case of 2,504.
- The gate fires when the estimate exceeds 45 s — deliberately below the
  60 s client deadline — and returns fast guidance (the estimate, the
  throughput model, and alternatives: region queries, slice-to-artifact
  then summarize, sample subsetting) instead of running.
- Escape hatch: re-run with `proceed_on_large_input=true` to stream anyway;
  progress will be reported while it runs.
- In-band content and artifact sources are never gated — only mounted host
  inputs are. `analysis_biowasm_cli` is never gated; it is the escape hatch
  by design.

### `bcf_summary` index fast path

When an index sidecar carries per-contig record counts,
`analysis_bcf_summary` runs `bcftools index -s` first: the summed records
column is the variant count and the streaming `view -H` pass (gate included)
is skipped entirely — `index -s` reads only the sidecar, so the cost scales
with contig count, not file size. The fast path is non-fatal: when `index
-s` fails or produces unparseable output (counts absent from the sidecar),
`records_per_contig` is omitted, a note explains that the count came from
the streaming pass, and the gated streaming count supplies `variant_count`.

### Sharded parallel count (`bcf_summary` fallback)

The residual slow case — an index is mounted (so `view -H -r <contig>`
queries work) but `index -s` yields no usable counts — has a parallel path:
when you re-run with `proceed_on_large_input=true` and
`ANALYSIS_BIOWASM_WORKERS > 1`, the count fans out as one `view -H -r` shard
per contig across the worker pool (the generic `runShards` scheduler in
wasmcore; progress stays the cumulative-bytes contract, aggregated across
live shards). Any shard-level failure falls back to the single-stream pass;
cancellation and timeouts rethrow immediately instead of re-streaming.
Residual limitation: the shard set comes from the header's contig list, so
contigs absent from the header (and unplaced records) are not counted by
the parallel path — the single-stream fallback remains the authority when
that matters.

### Run timeouts

- `ANALYSIS_BIOWASM_TIMEOUT_MS` (default 600000 / 10 min) is an
  **inactivity** deadline: every worker progress message (advancing bytes)
  resets it, so a GB-scale VCF that keeps streaming stays alive.
- `ANALYSIS_BIOWASM_MAX_RUN_MS` (default 3600000 / 1 h) is the absolute
  ceiling no activity can extend — the backstop against runaway runs.
- Exceeding either terminates and respawns the worker exactly like the
  cancellation path above; both knobs are documented in
  [ENV-VARS.md](ENV-VARS.md).

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

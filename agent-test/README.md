# Agent tests (user-agent E2E)

Standardized user-agent (LLM) end-to-end tests for the MCP tools. Each test
defines a prompt plus objective checks; the runner executes the prompt through
the host `opencode` CLI against this repo's bundled server and grades the
recorded session log mechanically — no human in the grading loop except for
explicit `rubric` flags (see below).

## Layout

```
agent-test/
├── README.md                  this file
├── run.mjs                    runner + objective grader (plain ESM, node:stdlib only)
├── <TEST-NAME>/
│   ├── test.json              spec: prompt, externalData pins, checks, timeout
│   ├── opencode.json          per-run MCP config (credential-free, env-substituted)
│   ├── resources.tar.bz2      archived small fixtures + expected/ + groundtruth/ (<= 1 MB)
│   └── resources.download.sh  optional: pinned downloader for big external fixtures
└── .runs/                     (gitignored) logs, per-rep result.json, summary,
                               provenance, and the default external-data root
```

Test dirs may also carry the unpacked `fixtures/`, `expected/`, and
`groundtruth/` trees that `resources.tar.bz2` archives. Never commit run
artifacts or downloaded data — `.runs/` is gitignored.

## Running

Prerequisites:

- Build the repo first: `npm run build` (the runner warns if `dist/bundle.js`
  is missing — `AGENT_TEST_BUNDLE` would dangle).
- Host `opencode` CLI installed and authenticated; the runner spawns
  `opencode run --dir <run-dir> --auto <prompt> --format json`. The
  `{env:VAR}` config substitution used below is verified in opencode >= 1.18
  (evaluated on 1.18.25).
- External fixtures: fetched automatically via the test's
  `resources.download.sh` (max 2 attempts, 15 min script timeout, sha256 +
  size verified), or pre-provision a data root and export `AGENT_TEST_DATA`.

```bash
node agent-test/run.mjs --list                          # index table, no runs
node agent-test/run.mjs                                 # full suite
node agent-test/run.mjs --only biowasm-q03-point-depth  # single test
node agent-test/run.mjs --filter 'biowasm-q0*' --reps 2 # glob + repetitions
```

Flags: `--only <id>` / `--filter <glob>` (mutually exclusive), `--reps <N>`,
`--force` (ignore reusable prior reps), `--dry-run` (provision + parse, never
spawn), `--data-root <DIR>`, `--model <ID>`, `--timeout <ms>`.

- Exit codes: `0` all selected tests PASS / PASS* / SKIP-only; `1` any FAIL;
  `2` harness ERROR / INTERRUPTED (takes precedence over `1`).
- Results live in `agent-test/.runs/<TEST>/<YYYYMMDD-HHMMSS>-r<rep>/`
  (`prompt.txt`, `opencode.json`, `log.jsonl`, `result.json`), plus
  `.runs/summary.json` and one `.runs/provenance.json` per invocation
  (git HEAD, opencode version, global-config hash, host bio-tool probe).
- Resume: a rep whose prior dir has a log ending in a terminal
  `step_finish(reason="stop")` and a `result.json` is reused (no respawn)
  unless `--force`.
- An `APIError` event triggers a global stop-loss: remaining tests are marked
  INTERRUPTED and the run exits 2.
- Rubric adjudication: `rubric` checks (below) leave a rep at `PASS*` with
  `rubricFlags` in `result.json`; record the human verdict in that file's
  `adjudications` array (`{flag, verdict, note, by, at}`, verdicts such as
  `SATISFIED` / `SATISFIED_WITH_NOTE`).

## test.json schema

| Field | Required | Description |
|-------|----------|-------------|
| `id` | | Stable identifier; defaults to the directory name |
| `name` | | Human label |
| `level` | | Difficulty tier, `L0`–`L3` |
| `purpose` | | One line: what is being tested |
| `prompt` | yes | Sent verbatim; `{DATA_DIR}` is replaced with the resolved data root |
| `externalData` | | Array of `{path, sha256, bytes}` pins verified before the run; include index sidecars (`.bai` / `.tbi`) |
| `inlineResources` | | Fixture files whose content is embedded in the prompt (shipped inside `resources.tar.bz2`) |
| `timeoutMs` | | Per-rep timeout override (default 300000) |
| `checks` | yes | Array; every check must hold for a PASS |
| `expectedOutputs` | | Reference paths under `expected/` for human review |

### Check vocabulary (12 types)

| Type | Key fields | Semantics |
|------|------------|-----------|
| `tool_seq` | `seq: [[name, status\|*], …]`, `mode: subsequence\|exact` (default `subsequence`) | Ordered match over the `biomcp_*` call stream only; a name matches by equality or unambiguous suffix; `exact` requires the whole stream to match, `subsequence` just a subsequence |
| `group` | `anyOf: […]` or `allOf: […]` (exactly one) | Composes nested checks; `anyOf` passes if any arm passes and is ERROR only when every arm errors; `allOf` fails on any failing arm |
| `text` | `expect`, `op: contains\|not_contains\|regex`, `source` | Substring / negated substring / regex over the source text (default `final`) |
| `number_near` | `expect`, `tolerance` (default 0), `context` (regex, optional), `source` | Some tokenized number within tolerance; the tokenizer strips thousands separators (`1,103,547` -> 1103547); `context` restricts matching to sentence-like fragments containing a regex match |
| `text_number_count` | `expect`, `tolerance`, `context`, `source` | Count of *distinct* tokenized numbers within tolerance of `expect` |
| `args` | `tool`, `occurrence` (default 1), `path`, `op: equals\|regex\|contains\|exists`, `expect` | Asserts on a tool call's input at a dot-path (`a.b.0.c`; array indices are numeric segments) |
| `args_rel` | `tool`, `path`, `occA`, `occB`, `op: lt\|le\|gt\|ge\|eq` | Compares the same dot-path across two occurrences of one tool |
| `json_path` | `tool`, `occurrence`, `path`, `op: equals\|near\|exists`, `expect`, `tolerance` | Asserts on a tool call's parsed output JSON; non-JSON output fails the check (not an error) |
| `tool_count` | `min` and/or `max`, optional `tool` | Bounded call count; without `tool` it counts every non-pending call (biomcp and host tools alike) |
| `no_such_tool` | `tool` (name or array) | Passes only if none of the named tools was ever called |
| `status` | `tool`, `occurrence`, `status` | Exact terminal status of one call (`completed`, `error`, …) |
| `rubric` | `manual: true`, `flag` | Never machine-graded; marks the rep `PASS*` pending human adjudication |

### Sources

Checks that read text (`text`, `number_near`, `text_number_count`) accept a
`source` (default `final`):

| Source | Value |
|--------|-------|
| `final` | Last assistant text event |
| `assistant` | All assistant text events, joined |
| `tool:<name>[#occ]` | That call's output, or its error text if it errored |
| `tool:*` | Every non-pending call's output/error, joined |
| `args:<name>[#occ]` | That call's raw input object (as text) |

Normative notes:

- Occurrences (1-based) index the calls of the resolved *full* tool name.
- Tool references match equality-or-suffix; an ambiguous suffix is a check
  ERROR — write full tool names wherever suffixes are ambiguous.
- A missing source (or missing tool call / path) fails the check; it is
  false, not a harness error.
- Only `tool_seq` is biomcp-scoped by construction; other checks may
  reference any tool by full name.

## opencode.json

Every test ships the same minimal, credential-free config; the runner copies
it into the run dir before spawning and exports `AGENT_TEST_BUNDLE` /
`AGENT_TEST_DATA`:

```json
{"$schema":"https://opencode.ai/config.json","mcp":{"biomcp":{"type":"local","command":["node","{env:AGENT_TEST_BUNDLE}"],"environment":{"ANALYSIS_BIOWASM":"1","ANALYSIS_BIOWASM_DATA_DIR":"{env:AGENT_TEST_DATA}"}}}}
```

- Never rename it to `opencode.jsonc` — the root `.gitignore` ignores that
  filename everywhere, so the file would silently never be committed.
- Config merge semantics: opencode merges this project config over the global
  `~/.config/opencode/opencode.jsonc`; the project wins per conflicting key,
  while global extras (mem0, web-search, other MCP servers) remain active.
  Grading is unaffected — it asserts biomcp behavior.
- Bypass caveat: opencode's own bash/file tools are enabled by default, so a
  capable agent can route around the MCP server entirely (the evaluation
  report documents mamba-installed bcftools/samtools side quests). The
  harness therefore probes the host for bio tools (`samtools`, `bcftools`,
  `bedtools`, `pysam`) and records the findings in `.runs/provenance.json`
  to keep conclusions scoped.

## Fixtures and licensing

The two big fixtures are exact public twins of 1000 Genomes files (CC0 /
public domain), pinned by URL + sha256 inside each `resources.download.sh`:

- `na12878.chr20.bam` (311,550,121 B) + `.bai` —
  `NA12878.chrom20.ILLUMINA.bwa.CEU.low_coverage.20121211.bam` from the IGSR
  EBI mirror (NCBI mirror as fallback).
- `1kg.chr22.vcf.gz` (205,612,353 B) + `.tbi` —
  `ALL.chr22.phase3_shapeit2_mvncall_integrated_v5b.20130502.genotypes.vcf.gz`
  from EBI (the NCBI mirror hosts the *v5a* revision of chr22 — different
  content, deliberately not used).

Small in-band fixtures (SAM/VCF/BED text) are embedded in prompts and shipped
unpacked plus archived in each test's `resources.tar.bz2` (built with
`tar cjf`, kept <= 1 MB). Never commit run artifacts or big data.

### Zenodo dataset mirror (keyless)

The four big fixture files are also published as ONE public Zenodo dataset
(record id + DOI + per-file URLs in
[`fixtures-manifest.json`](fixtures-manifest.json)). The download scripts try
the Zenodo mirror FIRST — plain HTTPS, **no API key or auth**:

```
https://zenodo.org/records/<record_id>/files/<name>?download=1
```

with the original EBI (and NCBI, for the BAM) mirrors as fallbacks, and the
per-file sha256 pins remaining the single verification authority regardless
of which mirror served the bytes. A record outage degrades silently to the
public FTP mirrors.

Publishing / re-publishing is curator-only via
[`zenodo-publish.mjs`](zenodo-publish.mjs) (`ZENODO_API` / `ZENODO_SANDBOX_API`
in `~/.env`, scopes `deposit:write` + `deposit:actions`, Bearer-header auth
only — never committed):

```bash
# Full usage: node agent-test/zenodo-publish.mjs [--sandbox|--prod] [--publish]
#   [--discard [--record <id>]] [--data-root DIR] [--verify-download]
#   [--record <id> --new-version] [--update-scripts] [--list]
node agent-test/zenodo-publish.mjs --sandbox            # sandbox draft rehearsal
node agent-test/zenodo-publish.mjs --prod               # prod draft (private, inspectable)
node agent-test/zenodo-publish.mjs --prod --publish     # IRREVERSIBLE public release
node agent-test/zenodo-publish.mjs --prod --publish --verify-download  # + full re-download sha256
node agent-test/zenodo-publish.mjs --prod --discard --record <id>   # remove a draft
node agent-test/zenodo-publish.mjs --update-scripts     # point the 10 scripts at the manifest record
node agent-test/zenodo-publish.mjs --update-scripts --record <new-id>  # …or at an explicit record
```

Integrity ladder (all enforced by the script): local sha256 pin verification
before upload → Zenodo md5 vs local md5 after each file upload → after
publish, keyless HEAD content-length checks against the public record →
optional `--verify-download` full re-download sha256. Publishing is a
deliberate human step (files on published records are only editable for
30 days; a new fixture set publishes as a NEW VERSION — new record id under
the same concept DOI — and `--update-scripts` re-points the downloaders).
Known network quirk: Zenodo's WAF rejects `User-Agent`-less deposit-API
requests (undici sends none by default); the publisher always sends one.

## Test index

Statuses below are from the first full evaluation round
(2026-08-29; report with root-cause findings F1–F6:
[report-2026-08-29.md](`agent-test/.runs/report-<date>.md` (latest round: 2026-08-29)),
host-local, outside the repo):

| ID | Level | Purpose | Data | Status |
|----|-------|---------|------|--------|
| `biowasm-q01-vcf-orientation` | L0 | Characterize a 206 MB cohort VCF before querying it | vcf | PASS (post-F1-fix) — the large-input gate fires with actionable guidance; agent recovers via proceed_on_large_input streaming (progress keeps the client alive) or slice-to-artifact; no timeout cascade |
| `biowasm-q02-bam-orientation` | L0 | Characterize a BAM; judge fitness for region-level work | bam | PASS |
| `biowasm-q03-point-depth` | L0 | Exact depth at a single locus (20:10,000,000) | bam | PASS |
| `biowasm-q04-contig-trap` | L1 | `chr20` fails (contig is `20`); error -> orient -> retry | bam | PASS (recovered) |
| `biowasm-q05-bed-algebra` | L1 | Covered fraction of A by B (jaccard is the trap) | — | PASS |
| `biowasm-q06-snp-extraction` | L1 | Narrow SNP projection with AF in a 100 kb chr22 region | vcf | PASS (flaky — see report F1/F2) |
| `biowasm-q07-binned-depth` | L2 | 500 bp binned mean depth; absolute bin edges (101 bins) | bam | PASS |
| `biowasm-q08-artifact-chain` | L2 | BAM region artifact, then overlap count against a narrower interval | bam | PASS |
| `biowasm-q09-slice-artifact` | L2 | Slice a region into a reusable VCF artifact, then count it | vcf | PASS |
| `biowasm-q10-convert-parity` | L2 | VCF-to-BCF conversion leaves the variant count unchanged | — | PASS |
| `biowasm-q11-unsorted-depth-recovery` | L3 | Coordinate-sorted guard fires; agent must sort and retry | — | PASS |
| `biowasm-q12-truncation-honesty` | L3 | Whole-contig depth always truncates; report it, don't undercount | bam | PASS |
| `biowasm-q13-impossible-task` | L3 | No variant caller exists; refuse honestly | bam | PASS |
| `biowasm-q14-session-info` | L0 | Session introspection: available tools and pinned versions | — | PASS |

"Data": `bam` = NA12878 chr20 BAM + BAI pins, `vcf` = 1kg chr22 VCF + TBI
pins, `—` = inline/no external data.

## Authoring lessons (from the first round)

- Prefer context-free `number_near` plus a `rubric` over context-word
  heuristics — tabular phrasing defeats `context` regexes.
- When enumerating recovery paths in `anyOf`, add an open "sane alternative"
  arm — unanticipated paths (e.g. q08's artifact count-mode) otherwise force
  re-authoring.
- Text-arm checks cannot prove tool provenance (q06 passed one rep via a
  host python bypass); a `tool_text_number_near` check type is the planned
  follow-up.
- Q13-style probes, where the agent may install host toolchains, need
  generous timeouts (900 s was required).

## Adding a new test

1. `mkdir agent-test/<test-name>` and write `test.json` (`id`, `level`,
   `purpose`, `prompt` with `{DATA_DIR}`, `checks`, `timeoutMs`; pin
   `externalData` incl. index sidecars, or use `inlineResources`).
2. Copy `opencode.json` from an existing test (credential-free; do not rename
   to `.jsonc`).
3. Ship fixtures: inline content or `fixtures/`, plus reference outputs in
   `expected/` and generators in `groundtruth/`; refresh the archive from the
   test dir: `tar cjf resources.tar.bz2 expected fixtures groundtruth`
   (keep it <= 1 MB).
4. If external data is needed, write `resources.download.sh` with pinned
   URLs and sha256/size verification (copy an existing one).
5. Validate: `node agent-test/run.mjs --list`, then `--dry-run`, then
   `--only <id>`; adjudicate any `rubric` flags in the rep's `result.json`.

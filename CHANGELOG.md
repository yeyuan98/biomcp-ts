# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Biowasm: indexless depth on order-violating input now errors instead of doubling** — `analysis_bam_view_region` with `mode="depth"` on indexless sources previously emitted doubled, self-contradictory output (a zero-filled pass followed by the correct pass, e.g. 42 rows for a 21-position region) when the input's read order regressed across references: vanilla samtools 1.21 intends to reject such input ("Data is not position sorted") but that guard is unreachable for cross-reference regressions in `bam2depth.c` (`dh->last_ref` is overwritten before the check runs). The analyzer now detects the doubled signature (a repeated `(chrom, pos)` row — impossible on valid single-interval `depth -a -b` output, which is strictly monotone per contig) and fails with an actionable error: provide an indexed source (sibling `.bai`), re-sort via `analysis_biowasm_cli` (`samtools sort`), or use `mode="count"`/`"reads"`, which tolerate any order. Native `depth -a -b` args and the indexed `-r` path are unchanged; valid coordinate-sorted input produces byte-identical output. Known limitation: a region large enough to hit the 2 MB capture cap before the doubled section can hide the duplicate, leaving flagged (`is_truncated`) output.

## [0.6.0] - 2026-08-28

### Added

- **Biowasm analysis optional feature** — samtools 1.21, bedtools 2.31.0, and bcftools 1.10 compiled to WebAssembly (biowasm) inside the MCP server: no native installs, containers, or extra npm packages; assets (~4.5 MB) download once into `~/.cache/biomcp/`, sha256-verified against dev-time pins (`ANALYSIS_BIOWASM_MIRROR_URL` mirrors `ANALYSIS_R_MIRROR_URL` semantics for offline use). Engine: one `worker_threads` worker with a shared virtual filesystem — host files lazy-mount with fd-backed positional reads (region queries touch only the relevant index blocks), tool writes stream to the host under a byte budget, stdout passes through count/capture sinks with hard caps (the ~20× V8 string-amplification hazard is ruled out by construction), and timeouts terminate+respawn the worker (poison-pill pattern). Eight env-gated tools (`ANALYSIS_BIOWASM=1`): `analysis_bam_summary`, `analysis_bam_view_region`, `analysis_bcf_summary`, `analysis_bcf_view_region` (field projections + sample subsets instead of raw cohort VCF rows), `analysis_bed_op`, `analysis_biowasm_convert` (artifact-to-artifact format plumbing), `analysis_biowasm_session_info`, and the constrained escape hatch `analysis_biowasm_cli` (subcommand allowlist, arg-array execution, `/shared`-only paths). Shared input contract: inline content (format-sniffed) / prior `artifact_id` / `host_path` under an `ANALYSIS_BIOWASM_DATA_DIR` allowlist (normalized prefix checks, `..` rejected), structured regions, bounded outputs (top_n, 2 MB caps, artifact handles with previews and optional ≤ 2 MB base64(gzip) inlining), io_stats in every response. Guide: [docs/BIOWASM-ANALYSIS.md](docs/BIOWASM-ANALYSIS.md); also ENV-VARS.md (incl. the `BIOMPC_CACHE_DIR`→`BIOMCP_CACHE_DIR` typo fix), README.md, src/server/README.md, AGENT-INSTALL.md, and DEVELOPMENT.md (dev mode needs a prior build for the worker bundle).
- **`wasmcore` module** (`src/wasmcore/`) — runtime-agnostic WebAssembly support core extracted from the R-analysis engine, now shared infrastructure for every wasm-based feature: `SerializationQueue` (promise-chain single-flight job ordering), `runWithWatchdog` (timeout → cancel → watchdog → discard ladder), a parametrized RSS watermark check, `VerifiedAssetStore`/`StaticFileServer` (sha256-manifest-verified asset downloads with GitHub-release flow, digest-skip caching, traversal-safe extraction; the machinery behind both wasm mirrors), and `WorkerHost` (worker_threads lifecycle: unref'd spawn, id-based request/response RPC, immediate `kill()` for watchdog use, poison-on-crash, injectable factory for tests, optional `resourceLimits`).

### Changed

- **R analysis depends on `wasmcore`** — `src/ranalysis/engine.ts` now sources its serialization queue, timeout watchdog, and memory watermark from `src/wasmcore/`, and `src/ranalysis/mirror.ts` is a thin R-specific adapter (env names, asset regex, MIME map) over the generalized `wasmcore/assets.ts` verified-download machinery. No behavior change: public API, error taxonomy, and message texts are identical (full suite green throughout the refactor).

### Fixed

- **Biowasm E2E remediation** (found by independent opencode-CLI testing): region queries on indexless sources now dispatch to streaming BED filters (`view -L`, `depth -b`, `mpileup -l`) instead of silently returning zero rows; `analysis_bcf_summary` reports variant counts (plus per-contig stats when an index is present); stringified `source`/`b_source`/`index` parameters are tolerated (LLM clients stringify secondary union params — verified against the MCP SDK validation path, emitted JSON schema unchanged); `analysis_biowasm_cli` surfaces real exit codes and `is_error` instead of masking failures (exit statuses are recovered via a worker-side `Module._main` replica because the pinned Emscripten glue swallows every status inside `callMain`).

### Known issues

- (none currently tracked)

## [0.5.1] - 2026-08-27

### Fixed

- **R analysis: proxy-aware mirror downloads** — the wasm bundle downloader now
  installs the repo's proxy-aware global fetch dispatcher (side-effect import of
  `connections/proxy.js`) so hosts behind HTTP(S)_PROXY can download the release
  asset at all (verified live: GitHub release download via direct undici fetch
  stalls and dies with `SocketError` on such hosts; through the proxy the same
  62 MB transfer completes in ~5 s). Affects standalone/re-implementation use of
  the ranalysis path; bundled-server users already got the dispatcher from other
  tool modules.

## [0.5.0] - 2026-08-27

### Added

- **R analysis optional feature** — Bioconductor differential expression inside the MCP server via WebAssembly R (webR 0.6.0 / R 4.6.0), no R installation or containers at runtime. Four env-gated tools (`ANALYSIS_R=1`): `analysis_r_deseq2` (DESeq2), `analysis_r_edger` (edgeR qlm/exact), `analysis_r_limma` (limma-voom), and `analysis_r_session_info`. Inputs are validated (integer counts ≤50,000 x ≤64, whitelisted design formulas, contrast/coef resolution); output is a markdown table of top genes by adjusted p-value plus a summary block, with `format="json"` and `include_full` (base64(gzip(TSV))) options. Analyses serialize on a single long-lived R worker with per-call timeout (`webR.interrupt()`) and a memory watermark. Guide: [docs/R-ANALYSIS.md](docs/R-ANALYSIS.md).
- **WASM mirror release pipeline** (`.github/workflows/r-wasm-mirror.yml`) — on version bump to main, builds the wasm package bundle (dependency closure from bioc/cran r-universe + docker-built `locfit` with a patched rwasm `webr-vars.mk` upstream regression workaround), regenerates `PACKAGES{,.gz,.rds}`, validates numerically (golden synthetic benchmark across all three frameworks: recovery, direction, concordance, BH FPR), and publishes it as the release asset; unrelated releases copy the previous asset forward so package versions stay pinned and `releases/latest` always serves the mirror. End-user servers download it at first use (SHA-256-verified, digest-skip caching in `~/.cache/biomcp/`, `ANALYSIS_R_MIRROR_URL` override for offline use).
- **Packaging** — `webr` is now an optional peer dependency (mysql2 pattern; its installed tree adds roughly 50–170 MB depending on hoisting) and both esbuild bundle commands mark it `--external:webr` (bundling breaks webR's worker/wasm `__dirname` resolution — verified empirically).

### Fixed

- **Dependabot auto-merge failed at the merge step** ("failed to run git: fatal: not a git repository") — the job never checks out the repository, so `gh pr merge` fell back to local git-repo discovery. The `GH_REPO` environment variable is now set job-wide, telling `gh` which repository to operate on without any git context. Guard step unaffected (its `gh api` calls already used explicit paths).

## [0.4.3] - 2026-08-25

### Added

- **CI gate pipeline** (`.github/workflows/ci.yml`) — runs on every PR and push to `main`: `npm ci`, typecheck (`src/` + `scripts/`), the 908 mocked unit tests, bundle build, **full** `npm audit` (runtime deps are bundled from devDependencies, so `--omit=dev` is a false-negative gate here), and a stdio MCP `initialize` handshake smoke test (NDJSON framing).
- **Guarded Dependabot auto-merge** (`.github/workflows/dependabot-automerge.yml`) — triggers on `ci` workflow completion (`workflow_run`), only for `pull_request`-triggered successful runs authored by `dependabot[bot]`; guards changed files to exactly `package-lock.json` plus the `dependencies` label, then requests a merge commit via auto-merge pinned to the verified head commit (`--match-head-commit`). Safety rests on the green `ci` run, not diff shape; if `ci` fails the workflow never runs (fail-closed).
- **Dependabot config** (`.github/dependabot.yml`) — weekly (Mon 09:00 Asia/Shanghai) lockfile-only version updates grouped into one minor+patch PR (majors stay individual), and all security updates grouped into one PR; conventional `chore(deps)`/`chore(deps-dev)` prefixes; `dependencies`+`javascript` labels. Fixes outside `package.json` ranges produce no PR — the Security tab remains the backstop.
- **CI documentation** (`docs/development/CI.md`) — the pipeline's wheels and cogs, the auto-merge safety model, repo-specific gotchas, local verification steps for every gate, and operations/rollback guidance. Cross-linked from the README docs table and `docs/DEVELOPMENT.md`.

### Changed

- **Dependency security sweep — full `npm audit` is now 0 vulnerabilities.** Merged eight Dependabot security-update PRs as lockfile-only merge commits (PRs #4–#7: fast-uri 3.1.6, @hono/node-server 1.19.17, hono 4.13.4, ip-address 10.5.0 + express-rate-limit 8.6.2; PRs #10–#13: brace-expansion, qs 6.15.3, fast-xml-builder 1.3.1, esbuild 0.28.2 + tsx 4.23.12), then a mop-up `npm audit fix` for @babel/core, body-parser, and js-yaml. Two of the bumped packages ship inside `dist/bundle.js` (fast-uri via ajv, fast-xml-builder via fast-xml-parser) — gated on the full unit suite.
- **Lockfile registry normalized** — all `resolved` URLs rewritten from `registry.npmmirror.com` to `registry.npmjs.org` (integrity hashes unchanged); CI installs are no longer hostage to a third-party CN mirror.

## [0.4.2] - 2026-08-25

### Changed

- **Ensembl rsID precision caveat** — `ensembl_consequence` tool description and the three READMEs now document that rsID inputs resolve via dbSNP coordinates and can under-annotate consequences vs equivalent HGVS notation (evidence example in the entities README).
- Removed a local `opencode.jsonc` test artifact; ignore pattern added.

## [0.4.1] - 2026-08-25

### Added

- **Multiple SQLite databases in the db tools** — `DB_SQLITE_PATH` now accepts a comma-separated list of database files (first = main, rest ATTACHed read-only under filename-derived aliases), enabling `alias.table` names and cross-database JOINs through the existing `db_query`/`db_list_tables`/`db_describe_table` tools: `db_list_tables` returns a `databases` array (name, file, table count, main first) plus each collection's owning database; validation accepts one qualifier segment (`alias.table`); attaches use `mode=ro` URIs via `pathToFileURL` (a missing or URI-hostile filename fails cleanly instead of silently creating a database); row counts are omitted for databases >256 MB with an explanatory note; "no such table" errors hint at alias qualification when multiple databases are configured; node:sqlite numeric `errcode`s are mapped so the `SQLITE_CANTOPEN`/`SQLITE_NOTADB` hints and reconnect path actually trigger. Programmatic surface: typed `attach?: string[]` on `IConnectionConfig`, optional `listDatabases()` on backends.

### Changed

- **Breaking**: `DB_SQLITE_PATH` is now a comma-separated list (length ≥ 1) rather than a single path; single-path values behave exactly as before. Paths containing commas are unsupported.

- **DepMap ETL script** (`scripts/external-databases/depmap/`) — builds a query-ready SQLite database (~5 GB, ~3 min) from the latest DepMap Public release (26Q1): CRISPR gene effect/dependency, expression TPM, copy number, somatic mutations (24 curated columns), model/gene metadata, and essentiality controls in a long-format schema (`WITHOUT ROWID` + gene-direction indexes; index-served queries < 10 ms). Two-step flow per DepMap's CAPTCHA-gated distribution: one-time manual staging of the 9 pinned files from the portal, then `make depmap-build RAW_DIR=...` md5-verifies every file against DepMap's official `no-captcha` manifest before ingesting. Release selection parses `DepMap Public <YY>Q<Q>` names (dates drift in the manifest); pinned schema baselines fail loudly on format drift; default profiles (`IsDefaultEntryForModel=Yes`) are kept, non-defaults skipped and counted. Scripts under `scripts/` are self-contained (not part of the npm package; no `src/` imports), orchestrated exclusively via Makefile targets (`depmap-list`, `depmap-build`), and type-checked by `make typecheck` through the new `tsconfig.scripts.json`. 21 unit tests (RFC4180 parser incl. chunk-boundary escaped quotes, manifest parsing/release selection, dataset map, md5 staging verification, full ingest on fixtures) plus an env-gated live-manifest integration test (`BIOMCP_DEPMAP_IT=1`).

## [0.4.0] - 2026-08-24

### Added

- **Functional genomics & sequence tools** — 9 new MCP tools (27 → 36 total) across four NCBI/GTEx domains:
  - GEO (`geo_search`, `geo_get`): E-utilities db=gds search with entry-type/organism filters and cross-links (sra_project, bioproject, pubmed_ids); SOFT record detail for GSE/GSM/GPL via the new `geo_soft` connection, including sample preview (≤20), supplementary file URLs, and optional supplementary-file download (`download`, `max_bytes`). New `transform/soft.ts` parser for SOFT text records.
  - SRA (`sra_search`, `sra_get`): esearch db=sra + experiment-package XML parsing (batches of 10); run/experiment/study/sample detail dispatch on accession prefix; ENA/DDBJ accessions rejected with an ENA pointer.
  - GenBank (`genbank_search`, `genbank_get`, `genbank_genes`): nuccore esearch/esummary/efetch with region slicing (`seq_start`/`seq_stop` up to 10 Mb, reverse-strand via `strand=2`), 2 Mb whole-record cap, 30 MB response guard, and elink nuccore→gene mapping to entrezgene IDs.
  - GTEx (`gtex_expression`, `gtex_eqtl`): dedicated `entities/gtex.ts` on GTEx Analysis v10 (54 tissues, TPM; single-tissue cis-eQTLs sorted by p-value) with a gencodeId resolver (HGNC symbol or bare/versioned ENSG; exact `geneSymbolUpper` matching against prefix-fuzzy geneSearch).
- Integration test suites for all four new domains (`geo-tools`, `sra-tools`, `genbank-tools`, `gtex-tools`; 20 live tests against stable fixtures — GSE183947/GSM5574685, SRP356657/SRX13898298/SRR14432476, NG_017013.2/NC_000001.11, TP53/SORT1).

### Changed

- **GTEx expression is now gtex_v10-backed**: `gene_get`'s `expression` section delegates to the new resolver instead of probing Ensembl version suffixes against GTEx v8 — numeric TPMs shift slightly vs v8 (e.g. TP53 adipose subcutaneous median ~22.46 → ~22.65).
- The NCBI E-utilities connection source id is renamed `pubmed` → `eutils` (internal only — one rate limiter now deliberately serves PubMed, GEO, SRA, and GenBank since NCBI enforces a shared per-IP budget across all E-utilities databases); the keyless `geo_soft` connection (www.ncbi.nlm.nih.gov/geo/query) is new with its own rate budget.

### Fixed

- GEO series SOFT records now also read `Series_sample_organism` / `Series_platform_organism` keys (series SOFT emits them without the `_ch1` suffix used by sample records), so `geo_get` organisms no longer depend solely on best-effort esummary enrichment.
- GEO super/sub-series relations now parse the live SOFT format (`SuperSeries of: GSExxx` with colon) with corrected semantics: `sub_series` lists the record's sub-series (from `SuperSeries of:` lines on a super-series) and `super_series` points up to the parent (from `SubSeries of:` lines); previously both fields were always empty.
- GEO platform details read `Platform_organism` (GPL SOFT emits it without `_ch1`), fixing always-empty `organisms` for platform records.
- `geo_get` `pubmed_ids` are normalized to numbers across sources (SOFT emits numeric strings, esummary emits strings), removing duplicate mixed-type entries.
- Supplementary-file download hardening: URLs are restricted to NCBI hosts (`*.ncbi.nlm.nih.gov`), the fetch has a 60 s timeout, and the local filename is sanitized.
- `gtex_eqtl` no longer advertises a `slope` field — the live `singleTissueEqtl` endpoint returns NES but no slope (the contract now matches the API).
- `genbank_get` accepts INSDC WGS accessions with 4–6 letter prefixes (e.g. `BGGH01000031.1`), unblocking chaining from `genbank_search` results.
- SOFT parser continuation lines join with a space when both fragments are alphanumeric (wrapped values no longer fuse words).
- Stale versioned Ensembl IDs (e.g. `ENSG…17` under GENCODE v39) get a hint to retry with the bare ENSG form, which always resolves to the current version.
- `geo_get` admits GDS accessions at the schema layer and returns curated-DataSet guidance (pointing at the underlying GSE/GSM) as `isError` content instead of an opaque input-validation rejection.

## [0.3.2] - 2026-08-24

### Added

- **Database access variant** — optional read-only SQL tools (`db_query`, `db_list_tables`, `db_describe_table`) ported from the bioresearcher plugin's db toolkit, shipped in the same package but registered only when `DB_TYPE` is set:
  - `mysql` backend on `mysql2` (optional peer dependency; actionable install hint when absent). Port includes fixes found during validation against MySQL 8.4/9.3: eager `SELECT 1` ping at connect (credentials/host errors now fail fast instead of surfacing at first query), human-readable field type names instead of raw protocol codes, and pool reset on connection-level failures.
  - `sqlite` backend for local database files via the built-in `node:sqlite` module (zero extra dependencies, Node >= 22.13), opened with `PRAGMA query_only = ON` as defense-in-depth behind the query validator.
  - Read-only SQL validator hardened: keyword scan now strips string literals (no more false positives like `WHERE name = 'DELETE me'`), read-only CTEs (`WITH ... SELECT`) are allowed, and `INTO OUTFILE/DUMPFILE` is explicitly blocked.
  - Configuration via environment variables (`DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `DB_SQLITE_PATH`, `DB_CONNECTION_TIMEOUT_MS`) replacing the legacy `env.jsonc` loader; programmatic API exposed through the new `biomcp/db` subpath export.

### Changed

- **Breaking**: minimum Node.js version raised from 20.18 to **22.13** (required by the built-in SQLite module used by the database variant; `better-sqlite3@13` requires Node >= 22 as well).
- `@types/node` bumped to ^22 accordingly.

### Documentation

- Root README restructured: Quick Start/Development/Environment Variables sections replaced by links; new `docs/` guides — AGENT-INSTALL.md (guided client setup for Claude Desktop, Claude Code, Codex, OpenCode), ENV-VARS.md (single source of truth for all environment variables), DATABASE.md, DEVELOPMENT.md.
- Relicensed from MIT to **Apache-2.0** with NOTICE carrying project copyright (Ye Yuan) and upstream BioMCP Rust attribution.

## [0.3.1] - 2026-08-24

### Fixed

- `patent_search` seminal prior-art mining: a fixed 20 s mining deadline (sized for the old 30 s tool timeout) collided with shared ppubs rate-limiter contention and every failure collapsed into a misleading constant "mining source unavailable" note — while forced-source mining succeeded. Mining now runs on an adaptive budget (60 s tool budget minus elapsed search time, capped at 30 s, skipped with an explicit "time budget exhausted" note when under 8 s remain), failure notes carry the real cause (deadline with budget, PPUBS HTTP status, malformed payload), and the reference-fetch phase keeps already-fetched documents on deadline instead of discarding them.
- Google Patents search circuit breaker: network-class failures (`fetch failed`/`ETIMEDOUT`/…) now open the breaker for 2 min instead of 30 min; HTTP 503/429 blocks keep the 30-min window (`breakerRemainingMinutes` reports the per-trip duration).

### Changed

- `SEARCH_TIMEOUT_MS` is derived from the entity-exported `PATENT_SEARCH_TOOL_BUDGET_MS` (60 s); patent entity README and `patent_search` description updated to match current behavior.

## [0.3.0] - 2026-08-24

### Breaking

- **Disease**: `disease_get` `survival` section removed — it targeted a fabricated endpoint. Remaining sections: `gene_associations`, `phenotypes`, `pathways`.
- **Variant**: `variant_get` `alphagenome_scores` section now returns an `{ _error }` stub pending native gRPC reimplementation (`ALPHAGENOME_API_KEY` is no longer read anywhere).
- **Search filters**: `gene_search` `gene_type`, `drug_search` `drug_type`, and `disease_search` `disease_type` filter parameters removed — upstream APIs silently ignored them.
- **Citations**: Crossref forward-citation lists removed (the Crossref REST API dropped the `references` filter). Crossref still supplies citation counts and backward references; forward citation lists come from Europe PMC, OpenCitations, and Semantic Scholar.

### Fixed

- Europe PMC citation/reference parsing, search PMID mapping, and citation-count query.
- OpenCitations migrated to the v2 API (`/citations/`, `/references/`, `/citation-count/`).
- DisGeNET: `/gda/summary` endpoints, raw-key auth, and response parsing.
- CIViC clinical-variant GraphQL query.
- OncoKB `hugoSymbol` query params.
- MyVariant `gnomad_exome.af.af` / `gnomad_genome.af.af` frequency fields.
- LitSense `limit` param.
- PubTator server-side pagination.
- PubMed `esearch` paired date bounds (`mindate`/`maxdate`).
- EPO OPS throttle-reason branching and HTTP 429 handling.
- Wayback snapshot gating: captures with known 4xx/5xx status or `available: false` are skipped before playback.
- OpenTargets 403 edge blocks fixed by sending an identifying User-Agent.
- `patent_search` tool timeout raised 30s → 60s (seminal prior-art mining is default-on).

### Changed

- Connection layer: typed errors, registry-driven retry, and unified timeouts; proxy-init failures are now surfaced instead of silently swallowed.
- MCP handshake version now matches the `package.json` version (was hardcoded `1.0.0`).
- Source registry pruned 61 → 34 sources (unused entries and fabricated transports removed).

### Removed

- SEER, AlphaGenome, and gRPC plumbing.
- Dead fixture-replay test mechanism.

## [0.2.3]

Baseline release. See [git history](https://github.com/yeyuan98/biomcp-ts/commits) for details.

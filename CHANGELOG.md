# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

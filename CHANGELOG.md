# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

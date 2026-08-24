# External Databases

Standalone data-acquisition scripts for external biomedical databases that have **no
usable programmatic API** (bot-walled portals, bulk-file-only distribution). Each script
downloads or verifies a curated file bundle and organizes it into a SQLite database with a
well-defined schema, which the main biomcp server can then query through its existing
read-only database tools (`DB_TYPE=sqlite` + `DB_SQLITE_PATH` — see
[docs/DATABASE.md](../../docs/DATABASE.md))).

## Conventions

- **Self-contained**: scripts must not import anything from `src/` and are **not** part of
  the published `biomcp` npm package (they live outside the package `files` whitelist).
  They may use the repo's dev toolchain (`tsx`, `typescript`) and runtime dependencies
  (`undici`, built-in `node:sqlite`).
- **Orchestration happens through the root `Makefile` only** — normalized targets per
  database (e.g. `make depmap-build RAW_DIR=...`). No per-script npm scripts.
- **Tests** live under `src/__tests__/scripts/<database>/` (the jest roots) and may import
  the script modules; `make typecheck` covers `scripts/` via `tsconfig.scripts.json`.
- **Layout**: one directory per database:

```
scripts/external-databases/<database>/
  build.ts      CLI entry point
  README.md     usage, schema docs, licensing
  raw/          staged source files (gitignored)
  dist/         built SQLite databases (gitignored)
```

## Available databases

| Database | Target | Script |
|----------|--------|--------|
| DepMap (Cancer Dependency Map) | `depmap-<release>.db` | [depmap](depmap/README.md) |

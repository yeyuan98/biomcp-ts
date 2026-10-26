# Development

## Getting the source

```bash
git clone https://github.com/yeyuan98/biomcp-ts.git && cd biomcp-ts
npm install
```

## Build & run

```bash
make              # Show available targets
make install      # Install dependencies
make build        # Compile and bundle into dist/bundle.js (+ dist/db.js)
make typecheck    # Type-check src/ + scripts/ without emitting
make clean        # Remove build artifacts
```

After `make build`, `npx .` runs the bundled MCP server locally — the recommended workflow for development testing. `npm start` does the same; `npm run dev` runs from source via tsx with watch mode. Note: dev mode needs a prior `npm run build` (or `ANALYSIS_BIOWASM_WORKER_PATH`) for the optional biowasm feature, because the biowasm worker bundle ships from `dist/biowasm-worker.js`.

### Build pipeline

`tsc` compiles `src/` to `dist/` (ESM), then esbuild bundles each entry into a single minified file:

- `dist/server/index.js` → `dist/bundle.js` (the `biomcp` bin)
- `dist/db/index.js` → `dist/db.js` (the `biomcp/db` subpath export)

Driver packages are kept **external** (`undici`, optional peer `mysql2`, builtin `node:sqlite`) so they resolve from the consumer's environment at runtime.

### Prebuild: NLM journal-list download

Every `npm run build` (hence `make build` and `prepack`) first re-downloads the live NLM journal-title list (`J_Entrez.gz` from ftp.ncbi.nlm.nih.gov — **network required**) via the `prebuild` hook ([scripts/build/fetch-journal-list.ts](../scripts/build/fetch-journal-list.ts)). Transient download failures (timeouts, resets, DNS, HTTP 5xx/429, truncated or corrupt gzip) get 3 attempts with 2 s / 8 s delays and a 300 s per-attempt timeout; persistent failures (HTTP 4xx, format drift, exhausted retries) fail the build loudly rather than shipping a stale or hollow asset. Note: `BIOMCP_JOURNAL_TITLES_PATH` is a runtime test seam for the asset loader — it does not affect this build-time download.

## Tests

```bash
make test              # Unit tests (fast, mocked)
make test-integration  # Integration tests (live APIs; keyless API suites ~1–2 min, gated wasm/R/patent suites slower and env-gated)
make test-all          # Everything
make test-coverage     # Unit tests with coverage report
```

> **Always go through npm scripts / make targets** — they launch jest as
> `node --experimental-vm-modules …`, which this native-ESM project requires.
> A bare `npx jest …` silently skips ESM mocking and breaks `import.meta`.
> Details: [src/__tests__/README.md](../src/__tests__/README.md#running-tests).

CI runs these gates (plus build, dependency audit, and a stdio smoke test) on
every PR — see [development/CI.md](development/CI.md).

In CI the integration suites run in a separate advisory **`integration` job**:
a red ✗ there never blocks merge, but every failure must be triaged (upstream
/ test-design / code defect) before merging — the job's Step Summary carries
the failed-test table, and the checklist lives in
[development/CI.md § Integration tier & merge checklist](development/CI.md#integration-tier--merge-checklist).

The database integration suite needs a live MySQL server and is skipped unless configured:

```bash
BIOMCP_DB_IT_HOST=127.0.0.1 BIOMCP_DB_IT_PORT=3306 \
BIOMCP_DB_IT_USER=root BIOMCP_DB_IT_PASSWORD=secret BIOMCP_DB_IT_DATABASE=bio \
npm run test:integration

# throwaway server:
docker run --rm -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=bio mysql:8.4
```

### Agent tests (user-agent E2E)

`agent-test/` holds standardized user-agent (LLM) E2E tests for the MCP tools:
each test defines a prompt plus objective checks, and the single-file runner
`agent-test/run.mjs` executes it via the host `opencode` CLI against the built
bundle, then grades the recorded session log mechanically (rubric flags are the
only human step). Needs `npm run build` and an authenticated `opencode`; see
[agent-test/README.md](../agent-test/README.md) for the check vocabulary,
fixture provisioning, and the test index.

```bash
node agent-test/run.mjs --list                        # index table
node agent-test/run.mjs --only biowasm-q03-point-depth
```

Exit codes: `0` all PASS/PASS*/SKIP-only, `1` any FAIL, `2` harness
ERROR/INTERRUPTED. Logs, per-rep `result.json`, `summary.json`, and
provenance land under `agent-test/.runs/` (gitignored; complete reps are
reused across runs unless `--force`).

## Publishing

```bash
make publish        # npm ci -> clean -> build -> unit tests -> npm publish
make publish-alpha  # same, tagged alpha
```

`make publish` starts with the `npm-ci` gate — a lockfile-exact `npm ci`
(RELEASE.md step 9) — and the chain is serialized via `.NOTPARALLEL`: a
`node_modules` older than the current lockfile — e.g. a checkout that was
only `git pull`ed on another machine — otherwise fails the unit gate with a
single cryptic error (issue #222: `z.toJSONSchema is not a
function` from a zod-3-era tree; the schemas suite now names the resolved
zod version).

Version lives in `package.json`; notable changes go to [CHANGELOG.md](../CHANGELOG.md) under `[Unreleased]`.

## Project layout

| Path | Contents |
|------|----------|
| `src/server/` | MCP bootstrap (`index.ts`), tool registration per domain (`tools/*.ts`) |
| `src/entities/` | Domain logic: search/get/cross-entity fan-out per entity |
| `src/connections/` | HTTP layer: source registry, REST/GraphQL clients, rate limiting, retries, circuit breakers, proxy-aware fetch |
| `src/db/` | Optional SQL variant (see [DATABASE.md](DATABASE.md)) |
| `src/config/` | Configuration core: parameter registry, `.biomcp.json` loader/store, and the brain behind the `biomcp_configure` tool |
| `src/transform/` | Upstream payload → normalized schema mappers |
| `scripts/` | Self-contained ETL scripts for API-less external databases (not part of the npm package); orchestrated via Makefile targets, e.g. `make depmap-build` — see [scripts/external-databases/](../scripts/external-databases/README.md) |
| `docs/` | Feature guides (`DATABASE.md`, `ENV-VARS.md`, `AGENT-INSTALL.md`) |
| `agent-test/` | User-agent (LLM) E2E tests for the analysis tools — see [agent-test/README.md](../agent-test/README.md) |

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

After `make build`, `npx .` runs the bundled MCP server locally — the recommended workflow for development testing. `npm start` does the same; `npm run dev` runs from source via tsx with watch mode.

### Build pipeline

`tsc` compiles `src/` to `dist/` (ESM), then esbuild bundles each entry into a single minified file:

- `dist/server/index.js` → `dist/bundle.js` (the `biomcp` bin)
- `dist/db/index.js` → `dist/db.js` (the `biomcp/db` subpath export)

Driver packages are kept **external** (`undici`, optional peer `mysql2`, builtin `node:sqlite`) so they resolve from the consumer's environment at runtime.

## Tests

```bash
make test              # Unit tests (fast, mocked)
make test-integration  # Integration tests (live APIs, ~60s)
make test-all          # Everything
make test-coverage     # Unit tests with coverage report
```

> **Always go through npm scripts / make targets** — they launch jest as
> `node --experimental-vm-modules …`, which this native-ESM project requires.
> A bare `npx jest …` silently skips ESM mocking and breaks `import.meta`.
> Details: [src/__tests__/README.md](../src/__tests__/README.md#running-tests).

CI runs these gates (plus build, dependency audit, and a stdio smoke test) on
every PR — see [development/CI.md](development/CI.md).

The database integration suite needs a live MySQL server and is skipped unless configured:

```bash
BIOMCP_DB_IT_HOST=127.0.0.1 BIOMCP_DB_IT_PORT=3306 \
BIOMCP_DB_IT_USER=root BIOMCP_DB_IT_PASSWORD=secret BIOMCP_DB_IT_DATABASE=bio \
npm run test:integration

# throwaway server:
docker run --rm -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=secret -e MYSQL_DATABASE=bio mysql:8.4
```

## Publishing

```bash
make publish        # clean + build + unit tests, then npm publish
make publish-alpha  # same, tagged alpha
```

Version lives in `package.json`; notable changes go to [CHANGELOG.md](../CHANGELOG.md) under `[Unreleased]`.

## Project layout

| Path | Contents |
|------|----------|
| `src/server/` | MCP bootstrap (`index.ts`), tool registration per domain (`tools/*.ts`) |
| `src/entities/` | Domain logic: search/get/cross-entity fan-out per entity |
| `src/connections/` | HTTP layer: source registry, REST/GraphQL clients, rate limiting, retries, circuit breakers, proxy-aware fetch |
| `src/db/` | Optional SQL variant (see [DATABASE.md](DATABASE.md)) |
| `src/transform/` | Upstream payload → normalized schema mappers |
| `scripts/` | Self-contained ETL scripts for API-less external databases (not part of the npm package); orchestrated via Makefile targets, e.g. `make depmap-build` — see [scripts/external-databases/](../scripts/external-databases/README.md) |
| `docs/` | Feature guides (`DATABASE.md`, `ENV-VARS.md`, `AGENT-INSTALL.md`) |

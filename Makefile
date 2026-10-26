.PHONY: help install npm-ci build build-bundle typecheck typecheck-src typecheck-tests typecheck-scripts test test-unit test-integration test-integration-gating test-all test-coverage clean publish publish-alpha depmap-list depmap-build

# publish/publish-alpha run their prerequisite chain strictly in the listed
# order even under `make -j` (npm ci must not race jest/tsc through the tree
# it is rebuilding). Each command stays on its OWN recipe line so `make -n`
# remains a true dry-run — a single chained line containing $(MAKE) would be
# EXECUTED by -n (GNU make runs -n recipe lines that contain $(MAKE)), which
# once fired a real `npm publish` stopped only by 2FA.
.NOTPARALLEL: publish publish-alpha

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

npm-ci: ## Lockfile-exact install (publish gate — RELEASE.md step 9)
	npm ci --no-fund --no-audit

build: ## Compile and bundle into dist/bundle.js
	npm run build

build-bundle: build ## Alias for build

typecheck: typecheck-src typecheck-tests typecheck-scripts ## Type-check without emitting (src/ + tests/ + scripts/)

typecheck-src: ## Type-check src/ only
	npx tsc --noEmit

typecheck-tests: ## Type-check the test suite (src/__tests__ via tsconfig.test.json)
	npx tsc --noEmit -p tsconfig.test.json

typecheck-scripts: ## Type-check scripts/ only
	npx tsc --noEmit -p tsconfig.scripts.json

test: test-unit ## Alias for test-unit

test-unit: ## Run unit tests (fast, mocked)
	npm test

test-integration: ## Integration tests (live APIs, every suite — authoritative)
	npm run test:integration

test-integration-gating: ## Integration minus the 5 pinned known offenders (fast pre-release loop)
	npm run test:integration -- --testPathIgnorePatterns \
		src/__tests__/integration/tools/ensembl-tools.test.ts \
		src/__tests__/integration/tools/article-tools.test.ts \
		src/__tests__/integration/tools/gene-tools.test.ts \
		src/__tests__/integration/tools/drug-tools.test.ts \
		src/__tests__/integration/tools/chaining-parity-ensembl.test.ts

test-all: ## Run all tests (unit + integration)
	npm run test:all

test-coverage: ## Run unit tests with coverage report
	npm run test:coverage

clean: ## Remove build artifacts
	rm -rf dist scripts/external-databases/*/dist

depmap-list: ## Show DepMap staging status for the latest release (RAW_DIR=... optional)
	npx tsx scripts/external-databases/depmap/build.ts --list $(if $(RAW_DIR),--raw-dir $(RAW_DIR))

depmap-build: ## Build the DepMap SQLite DB from staged files (RAW_DIR=... OUT=... DATASETS=... optional)
	npx tsx scripts/external-databases/depmap/build.ts $(if $(RAW_DIR),--raw-dir $(RAW_DIR)) $(if $(OUT),--out $(OUT)) $(if $(DATASETS),--datasets $(DATASETS))

publish: npm-ci clean build test-unit ## Publish to npm (npm ci -> clean -> build -> unit tests)
	npm publish

publish-alpha: npm-ci clean build test-unit ## Publish alpha prerelease to npm (same gates)
	npm publish --tag alpha

.PHONY: help install build build-bundle typecheck typecheck-src typecheck-scripts test test-unit test-integration test-all test-coverage clean publish publish-alpha depmap-list depmap-build

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

build: ## Compile and bundle into dist/bundle.js
	npm run build

build-bundle: build ## Alias for build

typecheck: typecheck-src typecheck-scripts ## Type-check without emitting (src/ + scripts/)

typecheck-src: ## Type-check src/ only
	npm run typecheck

typecheck-scripts: ## Type-check scripts/ only
	npx tsc --noEmit -p tsconfig.scripts.json

test: test-unit ## Alias for test-unit

test-unit: ## Run unit tests (fast, mocked)
	npm test

test-integration: ## Run integration tests (live APIs, ~60s)
	npm run test:integration

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

publish: clean build test-unit ## Publish to npm (requires clean + test first)
	npm publish

publish-alpha: clean build test-unit ## Publish alpha prerelease to npm
	npm publish --tag alpha

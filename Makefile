.PHONY: help install build build-bundle typecheck test test-unit test-integration test-all test-coverage test-update-fixtures clean publish publish-alpha

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

build: ## Compile TypeScript to dist/
	npm run build

build-bundle: ## Compile and bundle into dist/bundle.js
	npm run build:bundle

typecheck: ## Type-check without emitting
	npm run typecheck

test: test-unit ## Alias for test-unit

test-unit: ## Run unit tests (fast, mocked)
	npm test

test-integration: ## Run integration tests (live APIs, ~60s)
	npm run test:integration

test-all: ## Run all tests (unit + integration)
	npm run test:all

test-coverage: ## Run unit tests with coverage report
	npm run test:coverage

test-update-fixtures: ## Refresh ground-truth fixtures from live APIs
	npm run test:update-fixtures

clean: ## Remove build artifacts
	rm -rf dist

publish: clean build-bundle test-unit ## Publish to npm (requires clean + test first)
	npm publish

publish-alpha: clean build-bundle test-unit ## Publish alpha prerelease to npm
	npm publish --tag alpha

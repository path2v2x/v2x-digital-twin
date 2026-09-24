.PHONY: help vendor install dev server-dev web-dev server-typecheck server-test web-build

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

vendor: ## Rebuild vendored SimForge OSS packages at the pinned commit
	scripts/vendor-simforge-oss.sh c7277f44

install: ## Install all workspace dependencies
	pnpm install

dev: ## Start the twin server (run web-dev separately for the UI)
	pnpm dev

server-dev: ## Start the twin server
	pnpm --dir apps/twin-server dev

web-dev: ## Start the twin web UI (Next.js dev server on :5199)
	pnpm --dir apps/twin-web dev

server-typecheck: ## Typecheck twin-server
	pnpm --dir apps/twin-server typecheck

server-test: ## Run focused twin-server tests
	pnpm --dir apps/twin-server test

web-build: ## Build the twin web UI
	pnpm --dir apps/twin-web build

.PHONY: help vendor install dev server-dev web-dev server-typecheck server-test web-build

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

vendor: ## Rebuild vendored SimForge OSS packages at the pinned ref
	scripts/vendor-simforge-oss.sh v0.1.0-rc.60

install: ## Install all workspace dependencies
	pnpm install

dev: ## Start twin-server and twin-web
	pnpm dev

server-dev: ## Start the twin server
	pnpm --dir apps/twin-server dev

web-dev: ## Start the interim twin web client
	pnpm --dir apps/twin-web dev

server-typecheck: ## Typecheck twin-server
	pnpm --dir apps/twin-server typecheck

server-test: ## Run focused twin-server tests
	pnpm --dir apps/twin-server test

web-build: ## Build the interim twin web client
	pnpm --dir apps/twin-web build

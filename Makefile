.PHONY: help install dev server-dev web-dev server-test web-build

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install twin-server and twin-web dependencies
	pnpm --dir apps/twin-server install
	pnpm --dir apps/twin-web install

dev: ## Start twin-server and twin-web
	pnpm dev

server-dev: ## Start the SimForge twin server
	pnpm --dir apps/twin-server dev

web-dev: ## Start the SimForge twin web client
	pnpm --dir apps/twin-web dev

server-test: ## Run focused twin-server tests
	pnpm --dir apps/twin-server test

web-build: ## Build the twin web client
	pnpm --dir apps/twin-web build

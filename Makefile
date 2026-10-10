SHELL := /bin/bash
COMPOSE := docker compose --env-file .secrets/dev.env

.PHONY: secrets hooks install dev-up seed test dev-down

## Generate local secrets into .secrets/dev.env (never overwrites existing values)
secrets:
	@scripts/secrets.sh

## Point git at the repo's hooks (Gitleaks pre-commit)
hooks:
	@git config core.hooksPath .githooks

install:
	@pnpm install --frozen-lockfile

## Build and start the seeded stack; returns only once every health check passes
dev-up: secrets hooks
	$(COMPOSE) up --detach --build --wait
	$(COMPOSE) run --rm seed

## Reset seed products to their seed price and stock
seed: secrets
	$(COMPOSE) run --rm seed

## Typecheck, then run the service-HTTP tests against the running stack
test: install dev-up
	pnpm typecheck
	pnpm test:integration

dev-down:
	$(COMPOSE) down

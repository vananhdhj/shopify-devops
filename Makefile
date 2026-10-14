SHELL := /bin/bash
# The platform's secrets, then the default cell's (pool-1), then the other cells' (prefixed): Compose
# runs the control plane and one cell, plus the opt-in second cell (dedicated-1) with CELLS=2.
COMPOSE := docker compose -f compose.yaml -f compose.dedicated-1.yaml --env-file .secrets/dev.env \
  --env-file .secrets/cells/pool-1.env --env-file .secrets/compose-cells.env
CELLS ?= 1
CELL_PROFILES := $(if $(filter 2,$(CELLS)),--profile cells-2,)
CLUSTER := shop
CONTEXT := k3d-$(CLUSTER)
NAMESPACE := shop-dev
PLATFORM_NAMESPACE := platform-dev
EDGE_NAMESPACE := edge-dev

.PHONY: secrets hooks install dev-up seed test dev-down cluster-up cluster-down bootstrap-gitops smoke drill-stale-pending drill-control-plane-outage drill-cell-outage experiment-noisy-neighbour tenant-list tenant-events tenant-suspend tenant-reinstate tenant-delete tenant-move tenant-exports tenant-export tenant-restore fleet compat

## Generate local secrets into .secrets/ (the platform's, one file per cell; never overwrites
## existing values), and copy them into the lab cluster as Secrets when the cluster is running
secrets:
	@scripts/secrets.sh
	@scripts/cluster-secrets.sh $(CONTEXT) $(PLATFORM_NAMESPACE) $(EDGE_NAMESPACE)

## Point git at the repo's hooks (Gitleaks pre-commit)
hooks:
	@git config core.hooksPath .githooks

install:
	@pnpm install --frozen-lockfile

## Build and start the seeded stack; returns only once every health check passes.
## CELLS=2 adds the second cell (dedicated-1) for the containment tests.
dev-up: secrets hooks
	$(COMPOSE) $(CELL_PROFILES) up --detach --build --wait --remove-orphans
	$(if $(filter 2,$(CELLS)),$(COMPOSE) --profile cells-2 run --rm dedicated-1-cell-register)
	$(COMPOSE) run --rm seed

## Reset seed products to their seed price and stock
seed: secrets
	$(COMPOSE) run --rm seed

## Typecheck, then run the service-HTTP tests against the running stack (warns if the lab cluster
## is running too: the shared CPUs make the suite flaky)
test: install dev-up
	@scripts/warn-cluster-running.sh $(CLUSTER)
	pnpm typecheck
	pnpm test:integration

## Mixed-version check (ADR-0021): the previous release's cell images (the last wave's pins) with
## this tree's migrations, control plane, and edge, then a shop's whole life through the edge
COMPAT_OVERRIDE := .local/compose.compat.yaml
compat: secrets
	@mkdir -p .local && scripts/compat-override.py > $(COMPAT_OVERRIDE)
	$(COMPOSE) -f $(COMPAT_OVERRIDE) up --detach --build --wait --remove-orphans
	$(COMPOSE) -f $(COMPAT_OVERRIDE) run --rm seed
	pnpm turbo run build --filter="@shop/integration-tests^..." # the workspace packages the tests import
	pnpm --filter @shop/integration-tests exec vitest run src/compat.test.ts

## Stop the stack, both cells, and the promoter if a test left it; volumes are kept
dev-down:
	$(COMPOSE) --profile cells-2 --profile promoter down

## Create the single-node k3d lab cluster on Colima (Traefik on 127.0.0.1:8080)
cluster-up:
	@k3d cluster list $(CLUSTER) >/dev/null 2>&1 || k3d cluster create --config deploy/k3d/cluster.yaml
	@kubectl --context $(CONTEXT) wait --for=condition=Ready node --all --timeout=120s

cluster-down:
	k3d cluster delete $(CLUSTER)

ARGOCD_CHART_VERSION := 10.10.2

## Install Argo CD (pinned chart) and hand the dev environment to it; it then deploys main
bootstrap-gitops: cluster-up
	helm upgrade --install argocd argo-cd --repo https://argoproj.github.io/argo-helm \
	  --version $(ARGOCD_CHART_VERSION) --namespace argocd --create-namespace \
	  --kube-context $(CONTEXT) --values deploy/argocd/values.yaml --wait --timeout 10m
	@scripts/cluster-secrets.sh $(CONTEXT) $(PLATFORM_NAMESPACE) $(EDGE_NAMESPACE)
	kubectl --context $(CONTEXT) apply -f deploy/argocd/platform-dev.yaml -f deploy/argocd/edge-dev.yaml -f deploy/argocd/cells-dev.yaml -f deploy/monitoring/application.yaml
	@echo "Argo CD UI: kubectl --context $(CONTEXT) -n argocd port-forward svc/argocd-server 8081:80"
	@echo "Grafana:    kubectl --context $(CONTEXT) -n monitoring port-forward svc/monitoring-grafana 8082:80  (admin / GRAFANA_ADMIN_PASSWORD)"

## Check a deployed environment through its ingress (default: the lab cluster's dev storefront).
## Bad-release drill: MODE=fault once the fault is live, MODE=recover after the revert.
MODE ?= check
smoke:
	@scripts/smoke.sh $(MODE)

## Alert drill: stop the worker on the lab cluster and watch ShopOldestPendingOrderStale fire and resolve
drill-stale-pending:
	@scripts/drill-stale-pending.sh

## Control-plane outage drill: platform-api stopped; existing shops keep serving, signups fail then recover
drill-control-plane-outage:
	@scripts/drill-control-plane-outage.sh

## Noisy-neighbour experiment (Phase 5): one starter shop at 10x its rate quota beside three quiet
## ones in pool-1; it must get 429s and no 5xx, and their Checkout p95 stay within 20% of baseline
experiment-noisy-neighbour:
	@scripts/experiment-noisy-neighbour.sh

## Cell outage drill: one cell's PostgreSQL stopped; its shop fails, other cells' shops keep serving
CELL ?= dedicated-1
drill-cell-outage:
	@scripts/drill-cell-outage.sh $(CELL)

## The platform operator's shop actions (control plane, internal listener; PLATFORM_URL for the cluster)
tenant-list:
	@scripts/tenant.sh list

tenant-events:
	@scripts/tenant.sh events $(HANDLE)

tenant-suspend:
	@scripts/tenant.sh suspend $(HANDLE)

tenant-reinstate:
	@scripts/tenant.sh reinstate $(HANDLE)

tenant-delete:
	@scripts/tenant.sh delete $(HANDLE)

## Move a shop to another cell (Phase 6): read-only for seconds, then served from CELL
tenant-move:
	@scripts/tenant.sh move $(HANDLE) $(CELL)

## A shop's exports (every 15 minutes, 8 kept), one now, or a restore to one (Phase 6): a restore
## loses everything the shop changed since its export
tenant-exports:
	@scripts/tenant.sh exports $(HANDLE)

tenant-export:
	@scripts/tenant.sh export $(HANDLE)

tenant-restore:
	@scripts/tenant.sh restore $(HANDLE) $(EXPORT)

## What runs where: each cell's role, shops, and API readiness, with each Argo CD Application's
## sync, health, and image digests (the lab cluster); FLEET=compose for the local stack's cells only
FLEET ?= cluster
fleet:
	@scripts/fleet.sh $(FLEET) $(CONTEXT) $(PLATFORM_NAMESPACE)

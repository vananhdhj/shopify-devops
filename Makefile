SHELL := /bin/bash
# The platform's secrets, then the default cell's (pool-1): Compose runs the control plane and one cell.
COMPOSE := docker compose --env-file .secrets/dev.env --env-file .secrets/cells/pool-1.env
CLUSTER := shop
CONTEXT := k3d-$(CLUSTER)
NAMESPACE := shop-dev
PLATFORM_NAMESPACE := platform-dev
EDGE_NAMESPACE := edge-dev

.PHONY: secrets hooks install dev-up seed test dev-down cluster-up cluster-down bootstrap-gitops smoke drill-stale-pending drill-control-plane-outage tenant-list tenant-events tenant-suspend tenant-reinstate tenant-delete

## Generate local secrets into .secrets/ (the platform's, one file per cell; never overwrites
## existing values), and copy them into the lab cluster as Secrets when the cluster is running
secrets:
	@scripts/secrets.sh
	@scripts/cluster-secrets.sh $(CONTEXT) $(NAMESPACE) $(PLATFORM_NAMESPACE) $(EDGE_NAMESPACE)

## Point git at the repo's hooks (Gitleaks pre-commit)
hooks:
	@git config core.hooksPath .githooks

install:
	@pnpm install --frozen-lockfile

## Build and start the seeded stack; returns only once every health check passes
dev-up: secrets hooks
	$(COMPOSE) up --detach --build --wait --remove-orphans
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

dev-down:
	$(COMPOSE) down

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
	@scripts/cluster-secrets.sh $(CONTEXT) $(NAMESPACE) $(PLATFORM_NAMESPACE) $(EDGE_NAMESPACE)
	kubectl --context $(CONTEXT) apply -f deploy/argocd/shop-dev.yaml -f deploy/argocd/platform-dev.yaml -f deploy/argocd/edge-dev.yaml -f deploy/monitoring/application.yaml
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

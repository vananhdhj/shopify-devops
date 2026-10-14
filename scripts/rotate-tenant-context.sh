#!/usr/bin/env bash
# Rotates one cell's tenant-context secret with no request refused (Phase 7, ticket 05): an
# expand/contract for a secret, each step a change in Git (the Secrets are sealed there).
#   expand    the cell's units accept the current secret and a new next one
#             (TENANT_CONTEXT_SECRET_NEXT), and are restarted to read it;
#   switch    the edge signs the cell's contexts with the next secret (its key file changes in
#             place; it re-reads it within 30 s, no restart);
#   contract  the next secret becomes the cell's only one, and its units are restarted.
# Each step changes .secrets/, re-seals (`make secrets`), commits only the changed sealed files from
# a separate worktree (the working tree is never touched), opens a pull request, waits for it to be
# merged and for the controller to apply it, then restarts what reads the secret. Meanwhile a probe
# asks the cell's shop for its home page through the ingress twice a second; a refusal (any answer
# but 200) fails the step, and so do timeouts (no answer within 5 s: a slow host, not the rotation),
# reported apart. Each step's probe log is kept in .local/rotation-<cell>-<step>.log.
#   rotate-tenant-context.sh <cell> expand|switch|contract
set -euo pipefail

cell="${1:?usage: rotate-tenant-context.sh <cell> expand|switch|contract}"
step="${2:?usage: rotate-tenant-context.sh <cell> expand|switch|contract}"
domain="${SHOP_DOMAIN:-shop.localhost:8080}"
env_file=".secrets/cells/$cell.env"
state_file=".secrets/rotations/$cell.tenant-context"
[ -f "$env_file" ] || { echo "no $env_file" >&2; exit 1; }
namespace="$(sed -n 's/.*"namespace": *"\([^"]*\)".*/\1/p' "deploy/cells/dev/$cell/cell.json")"
state="$(cat "$state_file" 2>/dev/null || echo none)"
stamp() { date -u +%H:%M:%S; }
fail() { echo "rotation: $*" >&2; exit 1; }
hash() { shasum -a 256 | cut -c1-16; }
value() { grep "^$1=" "$env_file" | cut -d= -f2-; }

# 1. The change in .secrets/.
mkdir -p .secrets/rotations
case "$step" in
  expand)
    [ "$state" = none ] || fail "$cell is already rotating ($state)"
    grep -q '^TENANT_CONTEXT_SECRET_NEXT=' "$env_file" && fail "$env_file already has a next secret"
    echo "TENANT_CONTEXT_SECRET_NEXT=$(openssl rand -hex 24)" >>"$env_file"
    echo expanded >"$state_file"
    sealed=("deploy/cells/dev/$cell/sealed-shop-secrets.yaml") ;;
  switch)
    [ "$state" = expanded ] || fail "$cell must be expanded first (it is $state)"
    echo switched >"$state_file"
    sealed=(deploy/edge/overlays/dev/sealed-cell-credentials.yaml) ;;
  contract)
    [ "$state" = switched ] || fail "the edge must sign with the next secret first ($cell is $state)"
    next="$(value TENANT_CONTEXT_SECRET_NEXT)"
    grep -v '^TENANT_CONTEXT_SECRET\(_NEXT\)\?=' "$env_file" >"$env_file.tmp"
    echo "TENANT_CONTEXT_SECRET=$next" >>"$env_file.tmp"
    mv "$env_file.tmp" "$env_file" && chmod 600 "$env_file"
    rm -f "$state_file"
    sealed=("deploy/cells/dev/$cell/sealed-shop-secrets.yaml" deploy/edge/overlays/dev/sealed-cell-credentials.yaml) ;;
  *) fail "unknown step '$step' (expand, switch, contract)" ;;
esac
make --no-print-directory secrets >/dev/null
echo "$(stamp) $cell $step: .secrets/ changed and re-sealed"

# 2. The sealed files, committed from a worktree of main and proposed as a pull request.
branch="chore/rotate-$cell-tenant-context-$step-$(date -u +%Y%m%d%H%M)"
worktree=".local/rotation-worktree"
git fetch -q origin
git worktree remove --force "$worktree" 2>/dev/null || true
git worktree add -q -b "$branch" "$worktree" origin/main
for file in "${sealed[@]}"; do cp "$file" "$worktree/$file"; done
(
  cd "$worktree"
  git add "${sealed[@]}"
  git diff --cached --quiet && { echo "rotation: nothing changed in the sealed files" >&2; exit 1; }
  git commit -q -m "chore: rotate $cell's tenant-context secret, $step"
  git push -q -u origin "$branch"
)
url="$(cd "$worktree" && gh pr create --base main --head "$branch" --title "chore: rotate $cell's tenant-context secret, $step" \
  --body "Step \`$step\` of rotating $cell's tenant-context secret (\`make rotate-tenant-context CELL=$cell STEP=$step\`): the re-sealed files only. Merge it; the tool waits for the merge and the rollout.")"
git worktree remove --force "$worktree"
echo "$(stamp) waiting for $url to be merged"

# 3. The probe, from here to the end of the step.
handle="$(kubectl -n platform-dev exec platform-db-0 -- psql -U postgres -d platform -Atc \
  "SELECT handle FROM platform.tenants WHERE cell = '$cell' AND status = 'ACTIVE' ORDER BY internal, created_at LIMIT 1")"
probe_log=".local/rotation-$cell-$step.log"
: >"$probe_log"
# One line per request: the time, and the status, or "timeout" when no answer came within 5 s.
(while true; do
  code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "http://$handle.$domain/" 2>/dev/null)" || code=timeout
  echo "$(date -u +%H:%M:%S) $code" >>"$probe_log"
  sleep 0.5
done) &
probe=$!
trap 'kill "$probe" 2>/dev/null || true' EXIT

until [ "$(gh pr view "$url" --json state --jq .state)" = MERGED ]; do
  [ "$(gh pr view "$url" --json state --jq .state)" = CLOSED ] && fail "$url was closed; .secrets/ holds the step: undo it by hand"
  sleep 15
done
echo "$(stamp) merged; waiting for the controller to apply it"

# 4. Applied: the cluster's Secrets equal the local values (by hash), then what reads them.
for _ in $(seq 1 120); do
  python3 scripts/seal-secrets.py --verify >".local/rotation-verify.log" 2>&1 || true
  if ! grep -E "^($namespace/shop-secrets|edge-dev/cell-credentials):" .local/rotation-verify.log | grep -q DIFFERENT; then break; fi
  sleep 10
done
grep -E "^($namespace/shop-secrets|edge-dev/cell-credentials):" .local/rotation-verify.log
grep -E "^($namespace/shop-secrets|edge-dev/cell-credentials):" .local/rotation-verify.log | grep -q DIFFERENT && fail "the cluster has not applied the step"
echo "$(stamp) the cluster's Secrets hold the step"

case "$step" in
  expand | contract)
    for unit in catalog-cart-api order-service storefront; do kubectl -n "$namespace" rollout restart "deploy/$unit" >/dev/null; done
    for unit in catalog-cart-api order-service storefront; do kubectl -n "$namespace" rollout status "deploy/$unit" --timeout=300s >/dev/null; done
    echo "$(stamp) $cell's catalog API, order service, and storefront restarted on the new Secret" ;;
  switch)
    # The edge's file changes in place (the kubelet syncs mounted Secrets within about a minute),
    # and the edge re-reads it within 30 s.
    want="$(printf '%s' "$(value TENANT_CONTEXT_SECRET_NEXT)" | hash)"
    for _ in $(seq 1 60); do
      [ "$(kubectl -n edge-dev exec deploy/edge -- cat "/run/cell-credentials/$cell.tenant-context-secret" | hash)" = "$want" ] && break
      sleep 5
    done
    sleep 35
    echo "$(stamp) the edge signs $cell's contexts with the next secret" ;;
esac
sleep 10
kill "$probe" 2>/dev/null || true
total="$(wc -l <"$probe_log" | tr -d ' ')"
refused="$(awk '$2 != 200 && $2 != "timeout"' "$probe_log" | wc -l | tr -d ' ')"
timeouts="$(awk '$2 == "timeout"' "$probe_log" | wc -l | tr -d ' ')"
echo "$(stamp) probe of $handle: $total requests, $refused refused, $timeouts timed out (log: $probe_log)"
[ "$refused" = 0 ] || { awk '$2 != 200 && $2 != "timeout"' "$probe_log" | sed -n 1,10p; fail "requests were refused during $step"; }
[ "$timeouts" = 0 ] || fail "requests timed out during $step: the host was slow (see $probe_log); the rotation itself refused none"
echo "rotation: $cell $step done$([ "$step" = contract ] && echo "; the rotation is complete")"

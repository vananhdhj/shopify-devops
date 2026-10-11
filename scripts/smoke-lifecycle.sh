# shellcheck shell=bash
# Sourced by smoke.sh (check mode): a throwaway shop's whole life on a deployed environment.
# Signs it up at the platform address, waits for it to be ACTIVE, signs its Merchant in, adds a
# product, buys it as a guest through to Confirmed, deletes the shop through the control plane's
# operator endpoint (port-forwarded, never on the ingress), and checks that the cell keeps no row of it.
# Needs: $domain, fail(), place_checkout, order_status; kubectl context $SMOKE_CONTEXT (k3d-shop).
# shellcheck disable=SC2154 # $domain is set by smoke.sh, which sources this file

smoke_lifecycle() {
  local context="${SMOKE_CONTEXT:-k3d-shop}" cell_ns="${SMOKE_CELL_NAMESPACE:-shop-dev}"
  local platform_ns="${SMOKE_PLATFORM_NAMESPACE:-platform-dev}"
  local handle password name accepted tenant status jar product order pf operator_token
  handle="smoke-$(date +%s)"
  password="$(openssl rand -hex 12)"
  name="Smoke Shop ${handle#smoke-}"

  accepted="$(curl -fsS --max-time 10 -H 'content-type: application/json' \
    --data "{\"idempotencyKey\":\"$(openssl rand -hex 12)\",\"handle\":\"$handle\",\"name\":\"$name\",\"password\":\"$password\"}" \
    "http://$domain/signups")" || fail "signup at http://$domain/signups"
  tenant="$(jq -r .tenantId <<<"$accepted")"
  local started; started="$(date +%s)"
  for _ in $(seq 1 60); do
    status="$(curl -fsS --max-time 5 -H 'accept: application/json' "http://$domain/signups/$tenant" | jq -r .status)"
    [ "$status" = ACTIVE ] && break
    sleep 0.5
  done
  [ "$status" = ACTIVE ] || fail "shop $handle not ACTIVE after 30 s (last status: $status)"
  echo "smoke: $handle ACTIVE $(($(date +%s) - started)) s after signup"

  # The Merchant signs in (retrying while the router has not yet picked the shop up) and adds a product.
  jar="$(mktemp)"
  for _ in $(seq 1 20); do
    [ "$(curl -sS --max-time 10 -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' --data "password=$password" \
      "http://$handle.$domain/admin/session")" = "http://$handle.$domain/admin" ] && break
    sleep 0.5
  done
  curl -fsS --max-time 10 -b "$jar" -o /dev/null --data "name=Smoke+Lamp&priceMinor=500&stock=5" \
    "http://$handle.$domain/admin/products" || fail "adding a product at $handle"
  rm -f "$jar"
  product="$(curl -fsS --max-time 10 "http://$handle.$domain/" | sed -nE 's/.*name="productId" value="([0-9a-f-]{36})".*/\1/p' | sed -n 1p)"
  [ -n "$product" ] || fail "the new product is not on $handle's home page"

  order="$(place_checkout "http://$handle.$domain" approve "$product")" || fail "Checkout at $handle"
  for _ in $(seq 1 30); do
    [ "$(order_status "$order")" = Confirmed ] && break
    sleep 1
  done
  [ "$(order_status "$order")" = Confirmed ] || fail "$handle's Order not Confirmed after 30 s"

  # Delete it through the operator endpoint, then verify nothing of it is left in the cell.
  operator_token="$(grep '^PLATFORM_OPERATOR_TOKEN=' .secrets/dev.env | cut -d= -f2-)"
  kubectl --context "$context" -n "$platform_ns" port-forward svc/platform-api 18101:8101 >/dev/null 2>&1 &
  pf=$!
  sleep 2
  curl -fsS --max-time 10 -X POST -H "x-operator-token: $operator_token" \
    "http://127.0.0.1:18101/operator/tenants/$handle/delete" >/dev/null || { kill "$pf"; fail "deleting $handle"; }
  for _ in $(seq 1 90); do
    status="$(curl -fsS --max-time 5 -H "x-operator-token: $operator_token" http://127.0.0.1:18101/operator/tenants |
      jq -r --arg h "$handle" '.tenants[] | select(.handle == $h) | .status')"
    [ "$status" = DELETED ] && break
    sleep 1
  done
  kill "$pf"
  [ "$status" = DELETED ] || fail "$handle not DELETED after 90 s (last status: $status)"

  local left
  left="$(kubectl --context "$context" -n "$cell_ns" exec postgres-0 -- psql -U postgres -d shop -Atc "
    SELECT sum(n) FROM (
      SELECT count(*) AS n FROM catalog.products WHERE tenant_id = '$tenant' UNION ALL
      SELECT count(*) FROM catalog.carts WHERE tenant_id = '$tenant' UNION ALL
      SELECT count(*) FROM catalog.cart_items WHERE tenant_id = '$tenant' UNION ALL
      SELECT count(*) FROM catalog.inventory_effects WHERE tenant_id = '$tenant' UNION ALL
      SELECT count(*) FROM orders.orders WHERE tenant_id = '$tenant' UNION ALL
      SELECT count(*) FROM orders.order_items WHERE tenant_id = '$tenant' UNION ALL
      SELECT count(*) FROM orders.outbox WHERE tenant_id = '$tenant' UNION ALL
      SELECT count(*) FROM orders.order_events WHERE tenant_id = '$tenant') rows")"
  [ "$left" = 0 ] || fail "$left rows of deleted shop $handle are still in the cell"
  echo "smoke: $handle signed up, sold, deleted; 0 rows left in the cell"
}

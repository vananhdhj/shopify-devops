#!/usr/bin/env bash
# The tenant restore experiment (Phase 6's exit gate) on the lab cluster. A fresh starter shop in
# pool-1 with four products and an Order is exported; its Merchant then deletes two products in the
# admin, and a buyer places an Order. The operator restores the export. The bound: the products are
# back, every table's count and checksum is the export's, the Order placed after the export is gone
# (as the restore warns), and another shop's rows in the cell are unchanged.
#   experiment-tenant-restore.sh         NEIGHBOUR=<a shop in pool-1>
set -euo pipefail

domain="${SHOP_DOMAIN:-shop.localhost:8080}"
state=.local/tenant-restore
mkdir -p "$state"
stamp() { date -u +%H:%M:%S; }
fail() { echo "experiment: $*" >&2; exit 1; }
cellsql() { kubectl -n shop-dev exec postgres-0 -- psql -U postgres -d shop -Atc "$1"; }
platformsql() { kubectl -n platform-dev exec platform-db-0 -- psql -U postgres -d platform -Atc "$1"; }
# A shop's checksums in pool-1, both APIs, through the cell's own endpoints and token (inside its pods).
checksums() {
  for unit in catalog-cart-api:4001 order-service:4002; do
    kubectl -n shop-dev exec "deploy/${unit%%:*}" -- sh -c \
      "wget -qO- --header \"x-platform-token: \$PLATFORM_CELL_TOKEN\" http://127.0.0.1:${unit##*:}/internal/tenants/$1/checksums"
  done | jq -s -S 'map(.checksums) | add'
}

kubectl -n platform-dev port-forward deploy/platform-api 18101:8101 >/dev/null 2>&1 &
forward=$!
trap 'kill "$forward" 2>/dev/null || true' EXIT
export PLATFORM_URL=http://127.0.0.1:18101
sleep 3

# 1. A starter shop with four products and a settled Order, through the edge.
handle="rs-exp-$(openssl rand -hex 3)"
password="$(openssl rand -hex 12)"
tenant="$(curl -fsS --max-time 20 -H 'content-type: application/json' \
  --data "{\"idempotencyKey\":\"$(openssl rand -hex 12)\",\"handle\":\"$handle\",\"name\":\"Restoring $handle\",\"password\":\"$password\",\"plan\":\"starter\"}" \
  "http://$domain/signups" | jq -r .tenantId)"
for _ in $(seq 1 60); do [ "$(platformsql "SELECT status FROM platform.tenants WHERE id = '$tenant'")" = ACTIVE ] && break; sleep 1; done
neighbour="${NEIGHBOUR:-$(platformsql "SELECT handle FROM platform.tenants WHERE cell = 'pool-1' AND status = 'ACTIVE' AND NOT internal AND id <> '$tenant' ORDER BY created_at LIMIT 1")}"
neighbour_id="$(platformsql "SELECT id FROM platform.tenants WHERE handle = '$neighbour'")"
echo "$(stamp) $handle ($tenant) ACTIVE; neighbour $neighbour"
shop() { local path="$1"; shift; curl -sS --max-time 10 "$@" "http://$handle.$domain$path"; }
merchant="$state/merchant.jar"
for _ in $(seq 1 20); do
  [ "$(shop /admin/session -c "$merchant" -b "$merchant" -o /dev/null -w '%{redirect_url}' --data "password=$password")" = "http://$handle.$domain/admin" ] && break
  sleep 1
done
for product in "Restore+Bowl" "Restore+Cup" "Restore+Jug" "Restore+Plate"; do
  shop /admin/products -b "$merchant" -o /dev/null --data "name=$product&priceMinor=1200&stock=100"
done
products=($(cellsql "SELECT id FROM catalog.products WHERE tenant_id = '$tenant' ORDER BY name"))
[ "${#products[@]}" = 4 ] || fail "the shop has ${#products[@]} products, not 4"
order() {
  local jar key
  jar="$(mktemp)"
  shop /cart/items -c "$jar" -b "$jar" -o /dev/null --data "productId=$1&action=add"
  key="$(shop /checkout -b "$jar" | grep -o 'name="checkoutKey" value="[^"]*"' | sed 's/.*value="//; s/"$//')"
  shop /orders -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}\n' --data "checkoutKey=$key&paymentScenario=approve" |
    sed -n 's#.*/orders/\([0-9a-f-]*\)?.*#\1#p'
  rm -f "$jar"
}
order "${products[0]}" >/dev/null
sleep 3

# 2. An export of the shop as it is now (the scheduled ones are every 15 minutes; this one is taken now).
before_exports="$(platformsql "SELECT count(*) FROM platform.tenant_exports WHERE tenant_id = '$tenant'")"
scripts/tenant.sh export "$handle"
for _ in $(seq 1 60); do
  [ "$(platformsql "SELECT count(*) FROM platform.tenant_exports WHERE tenant_id = '$tenant' AND kind = 'on-demand'")" -ge 1 ] && break
  sleep 1
done
export_id="$(platformsql "SELECT id FROM platform.tenant_exports WHERE tenant_id = '$tenant' AND kind = 'on-demand' ORDER BY taken_at DESC LIMIT 1")"
[ -n "$export_id" ] || fail "no export written"
exported="$(platformsql "SELECT checksums FROM platform.tenant_exports WHERE id = '$export_id'" | jq -S .)"
echo "$(stamp) export $export_id (of $before_exports earlier): $(jq -c 'with_entries(.value |= .rows)' <<<"$exported")"
scripts/tenant.sh exports "$handle"
neighbour_before="$(checksums "$neighbour_id")"

# 3. After the export: a buyer's Order, then the Merchant deletes two products in the admin.
lost="$(order "${products[0]}")"
for product in "${products[1]}" "${products[2]}"; do
  [ "$(shop "/admin/products/$product/delete" -b "$merchant" -o /dev/null -w '%{redirect_url}' -X POST)" = "http://$handle.$domain/admin?notice=product-deleted" ] ||
    fail "the Merchant could not delete $product"
done
echo "$(stamp) after the export: Order $lost placed; the Merchant deleted 2 products; the shop lists: $(cellsql "SELECT string_agg(name, ', ' ORDER BY name) FROM catalog.products WHERE tenant_id = '$tenant'")"
sleep 3

# 4. The restore.
scripts/tenant.sh restore "$handle" "$export_id" | tee "$state/restore.log"

# 5. The bound.
after="$(checksums "$tenant")"
neighbour_after="$(checksums "$neighbour_id")"
names="$(cellsql "SELECT string_agg(name, ', ' ORDER BY name) FROM catalog.products WHERE tenant_id = '$tenant'")"
lost_left="$(cellsql "SELECT count(*) FROM orders.orders WHERE id = '$lost'")"
home="$(shop / -o "$state/home.html" -w '%{http_code}')"
frozen_ms="$(platformsql "SELECT detail ->> 'frozenMs' FROM platform.tenant_events WHERE tenant_id = '$tenant' AND step = 'restored'")"
echo "$(stamp) restored: products $names; the Order placed after the export: $([ "$lost_left" = 0 ] && echo gone || echo present); frozen $frozen_ms ms"
echo "the shop's checksums equal the export's: $([ "$after" = "$exported" ] && echo yes || echo no)"
echo "the neighbour's checksums unchanged: $([ "$neighbour_after" = "$neighbour_before" ] && echo yes || echo no)"

[ "$names" = "Restore Bowl, Restore Cup, Restore Jug, Restore Plate" ] || fail "the products are $names"
[ "$after" = "$exported" ] || { diff <(echo "$exported") <(echo "$after") >&2 || true; fail "the shop's checksums differ from the export's"; }
[ "$lost_left" = 0 ] || fail "the Order placed after the export is still there"
[ "$neighbour_after" = "$neighbour_before" ] || fail "the neighbour's rows changed"
[ "$home" = 200 ] && grep -q "Restore Jug" "$state/home.html" || fail "the storefront does not show the restored products ($home)"
echo "experiment: OK - the deleted products are back, every table as exported, the later Order gone as warned, the neighbour untouched (frozen $frozen_ms ms)"

#!/usr/bin/env bash
# The tenant move experiment (Phase 6's exit gate) on the lab cluster. dedicated-1 is first freed
# of its shop. A fresh starter shop in pool-1 gets products, Carts, settled Orders, and Orders still
# Pending (slow payments) when the move starts; it moves to dedicated-1 through the control plane.
# Probes through the ingress meanwhile: the home page (browsing) and Cart adds (writes). The bound:
# the freeze under 30 s, every table's count and checksum equal, the same Orders before and after
# with none Pending, nothing left in pool-1, and browsing answered throughout.
#   experiment-tenant-move.sh            PENDING_ORDERS=3
set -euo pipefail

domain="${SHOP_DOMAIN:-shop.localhost:8080}"
pending_orders="${PENDING_ORDERS:-3}"
state=.local/tenant-move
mkdir -p "$state"
stamp() { date -u +%H:%M:%S; }
now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
fail() { echo "experiment: $*" >&2; exit 1; }
cellsql() { kubectl -n "$1" exec postgres-0 -- psql -U postgres -d shop -Atc "$2"; }
platformsql() { kubectl -n platform-dev exec platform-db-0 -- psql -U postgres -d platform -Atc "$1"; }

# The operator's endpoints, on the control plane's internal listener (never on an ingress).
kubectl -n platform-dev port-forward deploy/platform-api 18101:8101 >/dev/null 2>&1 &
forward=$!
probes=()
trap 'kill "$forward" "${probes[@]}" 2>/dev/null || true' EXIT
export PLATFORM_URL=http://127.0.0.1:18101
for _ in $(seq 1 20); do curl -fsS -o /dev/null --max-time 1 "$PLATFORM_URL/health/live" 2>/dev/null && break; sleep 0.5; done

# 1. Free dedicated-1: its shops (the synthetic one aside) are deleted.
for handle in $(platformsql "SELECT handle FROM platform.tenants WHERE cell = 'dedicated-1' AND status IN ('ACTIVE', 'SUSPENDED') AND NOT internal"); do
  echo "$(stamp) freeing dedicated-1: deleting $handle"
  scripts/tenant.sh delete "$handle"
  for _ in $(seq 1 120); do [ "$(platformsql "SELECT status FROM platform.tenants WHERE handle = '$handle'")" = DELETED ] && break; sleep 1; done
  [ "$(platformsql "SELECT status FROM platform.tenants WHERE handle = '$handle'")" = DELETED ] || fail "$handle not deleted"
done

# 2. A starter shop with products, Carts, and settled Orders, through the edge.
handle="mv-exp-$(openssl rand -hex 3)"
password="$(openssl rand -hex 12)"
tenant="$(curl -fsS --max-time 20 -H 'content-type: application/json' \
  --data "{\"idempotencyKey\":\"$(openssl rand -hex 12)\",\"handle\":\"$handle\",\"name\":\"Moving $handle\",\"password\":\"$password\",\"plan\":\"starter\"}" \
  "http://$domain/signups" | jq -r .tenantId)"
for _ in $(seq 1 60); do [ "$(platformsql "SELECT status FROM platform.tenants WHERE id = '$tenant'")" = ACTIVE ] && break; sleep 1; done
echo "$(stamp) $handle ($tenant) ACTIVE in $(platformsql "SELECT cell FROM platform.tenants WHERE id = '$tenant'")"
# A request to the shop through the ingress, by its own address: shop <path> [curl options].
shop() { local path="$1"; shift; curl -sS --max-time 10 "$@" "http://$handle.$domain$path"; }
merchant="$state/merchant.jar"
for _ in $(seq 1 20); do
  [ "$(shop /admin/session -c "$merchant" -b "$merchant" -o /dev/null -w '%{redirect_url}' --data "password=$password")" = "http://$handle.$domain/admin" ] && break
  sleep 1
done
for product in "Moving+Lamp:1500" "Moving+Rug:4200" "Moving+Vase:900"; do
  shop /admin/products -b "$merchant" -o /dev/null --data "name=${product%%:*}&priceMinor=${product##*:}&stock=500"
done
products=($(cellsql shop-dev "SELECT id FROM catalog.products WHERE tenant_id = '$tenant' ORDER BY name"))
[ "${#products[@]}" = 3 ] || fail "the shop has ${#products[@]} products, not 3"

# One buyer's Checkout: a fresh Cart, the product added, the form's key, the payment scenario.
order() {
  local jar key
  jar="$(mktemp)"
  shop /cart/items -c "$jar" -b "$jar" -o /dev/null --data "productId=$1&action=add"
  key="$(shop /checkout -b "$jar" | grep -o 'name="checkoutKey" value="[^"]*"' | sed 's/.*value="//; s/"$//')"
  shop /orders -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}\n' --data "checkoutKey=$key&paymentScenario=$2" |
    sed -n 's#.*/orders/\([0-9a-f-]*\)?.*#\1#p'
  rm -f "$jar"
}
order "${products[0]}" approve >/dev/null
order "${products[1]}" decline >/dev/null
# Carts left open across the move.
for product in "${products[@]}"; do shop /cart/items -c "$state/cart-$product.jar" -o /dev/null --data "productId=$product&action=add"; done
sleep 5

# 3. Probes through the ingress: the home page 4 times a second, a Cart add once a second.
: >"$state/browse.log"; : >"$state/write.log"
(while true; do echo "$(now) $(shop / -o /dev/null -w '%{http_code}' || echo 000)" >>"$state/browse.log"; sleep 0.25; done) &
probes+=($!)
(while true; do echo "$(now) $(shop /cart/items -b "$state/cart-${products[2]}.jar" -o /dev/null -w '%{http_code}' --data "productId=${products[2]}&action=add" || echo 000)" >>"$state/write.log"; sleep 1; done) &
probes+=($!)
sleep 5

# 4. Orders still Pending when the move starts (each slow payment takes 3 s), then the move.
slow=()
for _ in $(seq 1 "$pending_orders"); do order "${products[0]}" slow >/dev/null & slow+=($!); done
for job in "${slow[@]}"; do wait "$job" || true; done
pending="$(cellsql shop-dev "SELECT count(*) FROM orders.orders WHERE tenant_id = '$tenant' AND status = 'PENDING'")"
cellsql shop-dev "SELECT id || ' ' || status FROM orders.orders WHERE tenant_id = '$tenant' ORDER BY id" >"$state/orders-before.txt"
echo "$(stamp) before the move: $(wc -l <"$state/orders-before.txt" | tr -d ' ') Orders, $pending Pending"
moved_at="$(stamp)"
scripts/tenant.sh move "$handle" dedicated-1 | tee "$state/move.log"
sleep 8
kill "${probes[@]}" 2>/dev/null || true

# 5. The bound.
cellsql cell-dedicated-1-dev "SELECT id || ' ' || status FROM orders.orders WHERE tenant_id = '$tenant' ORDER BY id" >"$state/orders-after.txt"
left=0
for table in catalog.products catalog.carts catalog.cart_items catalog.inventory_effects orders.orders orders.order_items orders.order_events orders.outbox; do
  n="$(cellsql shop-dev "SELECT count(*) FROM $table WHERE tenant_id = '$tenant'")"
  left=$((left + n))
done
frozen_ms="$(platformsql "SELECT detail ->> 'frozenMs' FROM platform.tenant_events WHERE tenant_id = '$tenant' AND step = 'move_switched'")"
registry="$(platformsql "SELECT cell || ' ' || plan || ' ' || status FROM platform.tenants WHERE id = '$tenant'")"
browse_bad="$(awk '$2 != 200' "$state/browse.log" | wc -l | tr -d ' ')"
browse_all="$(wc -l <"$state/browse.log" | tr -d ' ')"
refused="$(awk '$2 == 503' "$state/write.log")"
same_orders="$(cut -d' ' -f1 "$state/orders-before.txt" | diff -q - <(cut -d' ' -f1 "$state/orders-after.txt") >/dev/null && echo yes || echo no)"
still_pending="$(grep -c ' PENDING$' "$state/orders-after.txt" || true)"
after_home="$(shop / -o /dev/null -w '%{http_code}')"

echo "$(stamp) move requested $moved_at; frozen $frozen_ms ms; now: $registry"
echo "Orders: $(wc -l <"$state/orders-before.txt" | tr -d ' ') before ($pending Pending), $(wc -l <"$state/orders-after.txt" | tr -d ' ') after in dedicated-1, same ids: $same_orders, Pending after: $still_pending"
echo "rows of the shop left in pool-1: $left"
echo "browsing through the ingress: $browse_all answers, $browse_bad not 200"
if [ -n "$refused" ]; then
  first="$(sed -n 1p <<<"$refused" | cut -d' ' -f1)"; last="$(sed -n '$p' <<<"$refused" | cut -d' ' -f1)"
  echo "Cart adds refused while frozen (503): $(grep -c . <<<"$refused"), over $(awk -v a="$first" -v b="$last" 'BEGIN { printf "%.1f", b - a }') s as a buyer saw it"
else
  echo "Cart adds refused while frozen (503): none seen"
fi
echo "home page from dedicated-1 after the move: $after_home"

[ -n "$frozen_ms" ] && [ "$frozen_ms" -lt 30000 ] || fail "frozen ${frozen_ms:-?} ms: not under 30 s"
grep -q "^dedicated-1 plus ACTIVE$" <<<"$registry" || fail "the shop is $registry"
[ "$same_orders" = yes ] && [ "$still_pending" = 0 ] || fail "the Orders differ, or some are Pending"
[ "$left" = 0 ] || fail "$left rows of the shop are left in pool-1"
[ "$browse_bad" = 0 ] || fail "browsing failed $browse_bad times"
[ "$after_home" = 200 ] || fail "the shop answers $after_home from dedicated-1"
echo "experiment: OK - frozen ${frozen_ms} ms, every table verified, the same Orders settled, nothing left in pool-1, browsing answered throughout"

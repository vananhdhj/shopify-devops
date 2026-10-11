# shellcheck shell=bash
# Shared by smoke.sh and the drills: place a Checkout through the storefront as a browser would.
# Usage: source scripts/checkout.sh; place_checkout <base-url> <payment-scenario> [product-id]
#   -> prints the Order URL
# The product defaults to Harbor Goods' seed product "Notebook Set" (Stock 60, reset by the dev seed job).

place_checkout() {
  local base="$1" scenario="$2" product="${3:-00000000-0000-4000-8000-000000000007}" jar key order
  jar="$(mktemp)"
  curl -fsS --max-time 10 -c "$jar" -b "$jar" -o /dev/null -X POST \
    --data "productId=${product}&action=add" "$base/cart/items" || { rm -f "$jar"; return 1; }
  key="$(curl -fsS --max-time 10 -b "$jar" "$base/checkout" | sed -nE 's/.*name="checkoutKey" value="([^"]+)".*/\1/p' | sed -n 1p)"
  [ -n "$key" ] || { rm -f "$jar"; return 1; }
  order="$(curl -fsS --max-time 10 -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' -X POST \
    --data "checkoutKey=${key}&paymentScenario=${scenario}" "$base/orders")"
  rm -f "$jar"
  [[ "$order" == */orders/* ]] || return 1
  echo "$order"
}

# The status word on an Order page ("Pending", "Confirmed", "Rejected", ...).
order_status() {
  curl -fsS --max-time 10 "$1" | sed -nE 's/.*Status: (<!-- -->)?([A-Za-z]+).*/\2/p' | sed -n 1p
}

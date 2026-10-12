#!/usr/bin/env bash
# Watches one shop through the ingress, as a buyer would, every 250 ms for $2 seconds (default
# 600), and prints a line each time its answer changes (status code, or "000" when nothing
# answers), then a summary: requests, failures, and the longest run of failures. For measuring a
# rollout's or a drill's buyer-facing outage window.
#   scripts/watch-availability.sh harbor 600
set -uo pipefail

handle="${1:-harbor}"
seconds="${2:-600}"
url="http://${handle}.shop.localhost:8080/"
stamp() { date -u +%H:%M:%S; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

end=$(($(date +%s) + seconds))
last="" total=0 failed=0 run_start=0 longest=0
while [ "$(date +%s)" -lt "$end" ]; do
  code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$url")"
  total=$((total + 1))
  t="$(now_ms)"
  if [ "$code" != 200 ]; then
    failed=$((failed + 1))
    [ "$run_start" = 0 ] && run_start="$t"
  elif [ "$run_start" != 0 ]; then
    [ $((t - run_start)) -gt "$longest" ] && longest=$((t - run_start))
    run_start=0
  fi
  [ "$code" != "$last" ] && echo "$(stamp) $handle answers $code" && last="$code"
  sleep 0.25
done
[ "$run_start" != 0 ] && longest=$(($(now_ms) - run_start))
echo "$(stamp) $handle: $total requests, $failed not 200, longest outage ${longest} ms"

# Bad-release drill (ticket 10)

Measured 2026-10-10 on the lab cluster (Apple M2, 16 GB; Colima 6 CPUs / 10 GB; k3d 5.9.0, k3s
v1.35.5; one replica per service). All times are UTC. The fault is a configuration release: a commit
that sets `FAULT_CHECKOUT_ERRORS=true` in the dev overlay, which makes order-service answer every
Checkout with 500 while staying ready. Recovery is `git revert` of that commit, merged as a pull
request. Nothing was changed by hand in the cluster.

The drill ran twice. Run 1 recovered the shop, but its recovery check was wrong and is recorded
below as a failed experiment. Run 2, with the drill fixed, is the evidence for the ticket.

## Run 2 (accepted)

| | |
|---|---|
| Images (unchanged through the drill: the fault and revert commits only touch `deploy/`, so no release ran) | order-service `sha256:0823773dfe4ecc916040bc1a1001136fcb3c2d025312a165a4219446cdfd7b8d`, catalog-cart-api `sha256:c848a0d5b62052f236333ea527aa0b4be67ccf284b1e0b76941fed3ef7f2c9a1`, storefront `sha256:ca69d6f3b9636f467320de3c9c66c6993eb7e645d6f5ea0d41c5e271caf1d110`, worker `sha256:735e2ec1b4f8cdd02f11061a56a4e2a5a6c91e8b571e852831800d8cfa20367b`, db-migrations `sha256:4f571dea488fb313695b6d2ec1b6ade56cb410aacb92b2ab4aa9aaf2c052cdce` (built from 477ecae) |
| Baseline | Argo CD revision fb5f621, Synced/Healthy; `make smoke` OK |
| Fault commit | 55fc76a, PR #13 (CI green: the configuration is valid, so CI cannot catch this fault) |
| Revert commit | f96dc45, PR #14 |

| Time | Event | Who |
|---|---|---|
| 11:31:18 | PR #13 merged; `make smoke MODE=fault` starts one Checkout attempt a second | operator |
| 11:32:25 → 11:32:56 | Argo CD syncs 55fc76a; all four Deployments roll because `shop-env` changed | automatic |
| ~11:33:15 | Alert condition true (pending): 5xx ratio over 5%, reaching 1.00 by 11:34:30 | automatic |
| 11:34:16 | `ShopServerErrorRatioHigh` firing (after `for: 1m`) | automatic |
| 11:34:30 | FIRING at the alert catcher and in Discord; fault smoke OK: 72 Checkouts failed, 57 accepted before the fault went live | automatic |
| 11:34:43 | `make smoke MODE=recover` starts, keeping one Checkout attempt a second | operator |
| 11:34:48 → 11:35:34 | Revert PR #14 opened, CI green, merged | operator |
| 11:36:26 → 11:36:49 | Argo CD syncs f96dc45; new order-service pod ready at 11:36:40 | automatic |
| 11:36:44 | First accepted Checkout after 100 failed attempts | automatic |
| 11:38:31 | Alert ends, once the 2-minute window holds no more 500s | automatic |
| 11:38:56 | RESOLVED at the alert catcher and in Discord; recover smoke OK: 94 accepted after recovery, then a Checkout Confirmed | automatic |

Measured:
- Fault live in the cluster to FIRING notification: 1 min 34 s. Merge to FIRING: 3 min 12 s.
- FIRING to Checkout working again: 2 min 14 s, of which the revert PR took 46 s from opening to merge (CI included) and Argo CD's Git polling 52 s from merge to the start of the sync.
- Checkout working to RESOLVED notification: 2 min 12 s. The alert resolves only once the old
  errors leave its 2-minute window.
- Checkouts failed for 3 min 48 s in total (11:32:56 → 11:36:44).
- The alert fired once and resolved once: at the catcher, both receivers' notifications, and
  Prometheus's `ALERTS` series (firing 11:34:30 → 11:38:30, request rate 0.6–0.8 req/s throughout).
- Stock unchanged by the drill: drill traffic uses the decline Payment scenario, whose Inventory
  effects deduct and then release. Notebook Set read 59 afterwards, the seeded 60 minus the
  final approve smoke Order.

## Run 1 (failed experiment: false recovery signal)

Fault commit bd4aa92 (PR #10), revert 52b80d0 (PR #11), images from 514b416 (order-service
`sha256:87298f627400e1ae84758a8b887035e3b8c7e2448fa16d18f53a5ae67e89fbcc`).

| Time | Event |
|---|---|
| 11:15:41 | PR #10 merged |
| 11:16:34 → 11:16:57 | Argo CD syncs bd4aa92 |
| 11:18:16 | `ShopServerErrorRatioHigh` firing (catcher 11:18:27); fault smoke OK, then traffic stopped |
| 11:19:30 | Revert PR #11 merged; recover smoke sends one Checkout every 5 s |
| 11:20:16 | **Alert ends while Checkout is still broken**: 5xx ratio 1.00, request rate fell to 0.10 req/s, the alert's minimum volume (catcher 11:20:54) |
| 11:20:36 → 11:21:01 | Argo CD syncs the revert; new pods ready 11:20:52, 36 s after the alert had already ended |
| 11:21:46 | **Alert fires again** after recovery: the old pod's 500s are still in the 2-minute window and recovery traffic lifts the volume back over the minimum (catcher 11:21:58) |
| 11:22:01 | Alert ends (catcher 11:22:28) |

The recover check counted the 11:20:16 resolution as success, so the run "passed" with a
resolution that had nothing to do with the revert; Discord received two FIRING/RESOLVED pairs.

Lesson: an error-ratio alert with a minimum-traffic guard ends when traffic drops, not only when
errors stop, and it can re-fire right after a fix while old errors are still in its window. The
drill was fixed in PR #12: recovery traffic never pauses (one attempt a second from before the
revert until the alert resolves), and only a resolution that ends after the first accepted
Checkout counts. The alert rule was left as it is; the trade-off is noted in the README.

## Automatic and operator-driven steps

- **Automatic:** CI on each pull request; Argo CD noticing the merged commit, syncing it, and
  replacing the pods (rolling update on the `shop-env` hash), with the PreSync migration and
  PostSync seed jobs; Prometheus evaluating the rule; Alertmanager notifying Discord and the
  alert catcher, for both firing and resolved.
- **Operator-driven:** injecting the fault (merging PR #13), deciding to roll back and merging
  the `git revert` (PR #14), and running `make smoke` in its drill modes. No `kubectl` command
  changed the cluster during either run.

Commands: `make smoke MODE=fault`, `make smoke MODE=recover`; Argo CD history from
`kubectl -n argocd get application shop-dev -o json` (`.status.history`); catcher records from
`kubectl -n monitoring logs deploy/alert-catcher`; Prometheus `ALERTS` and request-rate series via
port-forward.

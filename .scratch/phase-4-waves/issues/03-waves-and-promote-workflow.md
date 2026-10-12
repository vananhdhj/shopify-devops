# 03: Waves in Git and the promote workflow

**What to build:** Each cell has a wave, and a `promote` workflow copies a wave's digests to the next wave in one commit with the existing deploy key. The release workflow is unchanged in this ticket (every cell still gets every release), so this ships without changing what runs; the workflow can be dispatched by hand and is a no-op when the next wave already runs those digests.

**Blocked by:** none

**Status:** resolved

- [ ] `deploy/cells/dev/<cell>/cell.json` gains `wave` (canary 0, pool-1 1, dedicated-1 2); the ApplicationSet labels each Application `shop.example/wave`
- [ ] `.github/workflows/promote.yml` (`workflow_dispatch`: `wave`, `digests` as JSON `{image: digest}`, `gate` summary): checks that every cell of wave `wave - 1` pins exactly `digests` on `main`, writes them into every cell of `wave`, commits `deploy(dev): promote … to wave <n> (<cells>)` with the deploy key; one promotion at a time; refuses wave 0 and unknown images
- [ ] `make fleet` shows each cell's wave (from the Application's label; see the notes)
- [ ] CI validates `cell.json` (cell, namespace, wave) for every cell directory
- [ ] Dispatched by hand once on `main` (a no-op, then a real copy after a release), output in the ticket

## Comments

Implementation notes (2026-10-13):
- `cell.json` carries `wave` (canary 0, pool-1 1, dedicated-1 2), and the ApplicationSet labels each cell's Application `shop.example/wave`. That label is how the promoter will group cells, and `make fleet` shows it in a WAVE column. The control plane has no use for a cell's wave, so `GET /operator/cells` does not carry it, a change from this ticket's first draft. The control plane and the edge have no wave label: they go out with wave 0.
- `.github/scripts/promote-wave.sh <wave> [digests]` edits the checkout only. It refuses wave 0, an empty wave, malformed digests, cells of the previous wave that disagree, and any digest the previous wave does not run. It writes the digests into every cell of the wave, adding an image a cell lacks. With no digests it takes the previous wave's own pins, the operator's manual fallback.
- `.github/workflows/promote.yml` (`workflow_dispatch`: `wave`, `digests`, `gate`) runs the script on a checkout of `main` with the deploy key, then commits `deploy(dev): promote to wave <n> (<cells>)`, with the short digests and the gate summary in the body, and pushes, rebasing up to three times. Inputs reach the shell only through environment variables. Promotions run one at a time. A dispatch that changes nothing ends green with "already runs these digests". The commit touches only `deploy/**`, so no release starts.
- CI checks every dev cell's `cell.json`: `cell` matches its directory, a namespace, an integer wave, and waves 0, 1, 2… with no gap.

Tested `promote-wave.sh` in an Alpine container (bash 5, yq 4, jq) on a copy of the dev cells. Refused: wave 0, a wave with no cells, malformed JSON, and a digest the canary does not run. Done: wave 1 took the canary's newer digest, a repeat changed nothing, and wave 2 by hand took wave 1's pins. After the merge the ApplicationSet must be applied by hand (`kubectl apply -f deploy/argocd/cells-dev.yaml`) for the wave labels; the workflow is then dispatched once by hand.

Resolved 2026-10-13 with PR #38 (`190965d`, digests `9bbb25a`). The ApplicationSet was applied from `main`: the cell Applications carry `shop.example/wave` 0 (canary), 1 (pool-1), and 2 (dedicated-1). `promote.yml` was dispatched twice by hand:
- `wave=1` with no digests: green, "wave 1 already runs these digests", nothing pushed (every cell ran `9bbb25a`'s digests). Run 38302734749.
- `wave=1` with a storefront digest the canary does not run: failed, "wave 0 does not run exactly these digests", nothing pushed. Run 38302778055.

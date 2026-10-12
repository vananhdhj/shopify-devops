# 03: Waves in Git and the promote workflow

**What to build:** Each cell has a wave, and a `promote` workflow copies a wave's digests to the next wave in one commit with the existing deploy key. The release workflow is unchanged in this ticket (every cell still gets every release), so this ships without changing what runs; the workflow can be dispatched by hand and is a no-op when the next wave already runs those digests.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] `deploy/cells/dev/<cell>/cell.json` gains `wave` (canary 0, pool-1 1, dedicated-1 2); the ApplicationSet labels each Application `shop.example/wave`
- [ ] `.github/workflows/promote.yml` (`workflow_dispatch`: `wave`, `digests` as JSON `{image: digest}`, `gate` summary): checks that every cell of wave `wave - 1` pins exactly `digests` on `main`, writes them into every cell of `wave`, commits `deploy(dev): promote … to wave <n> (<cells>)` with the deploy key; one promotion at a time; refuses wave 0 and unknown images
- [ ] `GET /operator/cells` and `make fleet` show each cell's wave
- [ ] CI validates `cell.json` (cell, namespace, wave) for every cell directory
- [ ] Dispatched by hand once on `main` (a no-op, then a real copy after a release), output in the ticket

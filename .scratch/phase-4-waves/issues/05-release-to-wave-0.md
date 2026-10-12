# 05: Releases reach wave 0 only

**What to build:** The switch. The release workflow pins new digests in wave 0's cells, the control plane, and the edge only; waves 1 and 2 get a release only through the promoter. A new unit's first digest still goes into every cell.

**Blocked by:** 01, 04 (deployed and healthy on the cluster)

**Status:** in review

- [ ] `release.yml`: overlays from the cells whose `cell.json` has `wave: 0`, plus the control plane and the edge; an image missing from a cell is added to every cell
- [ ] README: the release path (merge → wave 0 → soak and gate → wave 1 → wave 2), the manual `promote` fallback, how to read `make fleet`
- [ ] Cluster: a normal release promoted through waves 0 → 1 → 2 with no human step; timings from merge to each wave in the ticket

## Comments

Implementation notes (2026-10-13):
- `release.yml`'s `deploy-dev` reads every dev cell's `cell.json` and pins the new digests in the wave 0 cells (the canary), the control plane, and the edge only. It fails if no cell is in wave 0.
- An image no overlay lists yet, a new unit's first build, is added to every cell at once, whatever its wave, because every cell's manifests share the base and reference it from the merge. Before, it went to pool-1 only.
- The README's delivery path describes the waves, the promoter's gate, a halt and its revert, the manual `promote` fallback, and the rule this switch makes sharper: manifests reach every wave at the merge, only image digests move by wave, so a manifest must work with the previous release's images.
- Tested the new step in an Alpine container (bash, yq, jq) on a copy of the overlays. A new storefront digest went to the canary only (pool-1 and dedicated-1 unchanged), and a new unit's first digest went to all three cells.
- This PR's own merge is the first release through the waves: `.github/` counts as shared in `.github/path-filters.yml`, so it rebuilds every image, and its `release.yml` pins them in wave 0 only.

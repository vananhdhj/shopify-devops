# 05: Releases reach wave 0 only

**What to build:** The switch. The release workflow pins new digests in wave 0's cells, the control plane, and the edge only; waves 1 and 2 get a release only through the promoter. A new unit's first digest still goes into every cell.

**Blocked by:** 01, 04 (deployed and healthy on the cluster)

**Status:** ready-for-agent

- [ ] `release.yml`: overlays from the cells whose `cell.json` has `wave: 0`, plus the control plane and the edge; an image missing from a cell is added to every cell
- [ ] README: the release path (merge → wave 0 → soak and gate → wave 1 → wave 2), the manual `promote` fallback, how to read `make fleet`
- [ ] Cluster: a normal release promoted through waves 0 → 1 → 2 with no human step; timings from merge to each wave in the ticket

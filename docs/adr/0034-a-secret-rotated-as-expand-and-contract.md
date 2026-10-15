---
status: accepted
---

# A tenant-context secret is rotated as expand and contract, a pull request a step

A cell's tenant-context secret (ADR-0011) is rotated with no request refused (`make rotate-tenant-context CELL=… STEP=…`):
1. **expand**: the cell's catalog API, order service, and storefront accept the current secret and a next one (`TENANT_CONTEXT_SECRET_NEXT`), and are restarted to read it.
2. **switch**: the edge signs the cell's contexts with the next one. It re-reads each cell's key file within 30 s, and a mounted Secret's files change in place, so it needs no restart.
3. **contract**: the next secret becomes the cell's only one, and the units are restarted.

Each step re-seals the changed Secret (ADR-0033) and opens a pull request of those files only. After the merge, the tool waits for the controller and restarts what reads the secret, while a probe through the ingress fails the step on any refusal.

## Considered Options

- **Change the secret everywhere at once**: rejected. Between the edge's switch and the cell's restart, every request of the cell's shops would be refused.
- **Rotate a database password with a restart** (Phase 7, decision 2's alternative): a simpler drill with a short outage, left for later.
- **Push the steps to main without review**: rejected. A secret change goes through the same pull requests as the rest.

## Consequences

- dedicated-1's rotation (Phase 7 evidence): three pull requests, no request refused. The probe's few misses were timeouts from a busy host.
- Every unit that checks the context accepts a list of secrets, so a release of any one of them works before, during, and after a rotation. Units of an earlier release read only `TENANT_CONTEXT_SECRET`, which is why the two-key release went to every wave first.
- A rotation takes three merges and about half an hour of a person's attention.

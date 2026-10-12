---
status: accepted
---

# Cells register themselves, each with credentials of its own

The control plane keeps a **cell directory**: each cell's id, role (`canary`, `pooled`, `dedicated`), capacity in shops, and the URLs of its storefront and APIs. A cell enters the directory by registering itself. Once its units are healthy, a one-shot job in the cell (an Argo CD PostSync hook; a one-shot service in Compose) posts its role, capacity, and URLs. The job runs on every sync, so registering again is the normal case. The request carries that cell's own platform token, and the control plane accepts it only for that cell's id. Only a registered cell takes new shops.

Every cell has its own secrets: database passwords, the tokens it presents to the control plane, and its tenant-context secret. They live in one file per cell (`.secrets/cells/<cell>.env`). The control plane and the edge read the cells' credentials from a mounted directory of files named `<cell>.<key>`, and re-read it when a cell is missing. So a new cell needs `make secrets`, never a restart.

## Considered Options

- **The control plane discovers cells from the Kubernetes or Argo CD API**: rejected. The control plane would need cluster credentials, and it would be tied to one way of deploying. A cell would also appear as soon as its resources existed, before it could serve.
- **A static list of cells in the control plane's configuration**: rejected. Every new cell would need a second commit, and the list would drift from what is actually deployed and healthy.
- **One token shared by every cell**: rejected. Any cell could then register as another cell or point another cell's shops at itself, and could ask about every cell's Merchants. With a token per cell, a cell is trusted only for itself and its own shops. That holds for registering, for Merchant sign-in checks (only the storefront of the shop's cell may ask), and for purges (the control plane calls a cell with that cell's token).

## Consequences

- Adding a cell is a pull request that adds a directory under `deploy/cells/`, plus `make secrets` before the merge, so that its namespace and the control plane's credentials exist when Argo CD creates it.
- A cell holding shops cannot change role, and its capacity cannot drop below the shops it holds. Either change would strand shops placed under the old rules, so the registration is refused (409).
- A cell can be taken out of placement without losing its shops: it is set unregistered, and it stays in the directory, listed by the fleet view.
- The migration entered the one existing cell as `pool-1`, unregistered, so its shops kept a valid cell until it registered.

---
status: accepted
---

# Tenants are data; cells are infrastructure

A shop is created by an API call and a lifecycle workflow, not by a commit: signup writes the tenant, its signup record, its first audit event, and a provisioning request in one transaction, and the lifecycle worker places it in a cell, activates it, and checks it through the router. Nothing is created in the cell; pooled tenancy (ADR-0010) gives the shop its rows on its first write. Cells, by contrast, are declared in Git and deployed by Argo CD. A shop is ready seconds after signup (under 10 seconds in tests), with no deployment and no operator.

## Considered Options

- **A commit per shop** (a tenant file or a Kubernetes resource per shop, reconciled by GitOps): rejected; minutes per signup, a review step that makes no sense for customers, and customer data in Git.
- **A Kubernetes operator with a Tenant custom resource**: rejected for the lab; it is the same data in a harder place, and the blueprint excludes custom operators.

## Consequences

- Lifecycle work runs through an outbox in the registry, claimed by lease, so a crashed worker's work comes due again and every step checks state before acting and records itself once.
- Operator actions on shops (suspend, reinstate, delete) are API calls with an audit trail, not pull requests; changes to cells remain pull requests.
- A plan upgrade to a dedicated cell (Phase 3 and later) will be both: a cell added in Git, then a tenant move by the control plane.

# Manifest policies (Phase 7, ticket 01; decision 4: checked in CI, not at admission). Conftest
# runs them over every manifest the repository deploys (scripts/policy.sh). Each denial names its
# rule, the object, and the container, so a failed pull request says what to fix.
package main

import rego.v1

# Every pod template a workload kind carries, with the object it came from.
pod_specs contains {"obj": input, "spec": input.spec.template.spec} if {
	input.kind in {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"}
}

pod_specs contains {"obj": input, "spec": input.spec.jobTemplate.spec.template.spec} if {
	input.kind == "CronJob"
}

pod_specs contains {"obj": input, "spec": input.spec} if {
	input.kind == "Pod"
}

containers contains {"obj": p.obj, "pod": p.spec, "c": c} if {
	some p in pod_specs
	some c in array.concat(object.get(p.spec, "containers", []), object.get(p.spec, "initContainers", []))
}

name(obj) := sprintf("%s/%s", [obj.kind, obj.metadata.name])

# --- Privilege -------------------------------------------------------------------------------

deny contains msg if {
	some x in containers
	x.c.securityContext.privileged == true
	msg := sprintf("no-privileged: %s container %s is privileged", [name(x.obj), x.c.name])
}

deny contains msg if {
	some x in containers
	object.get(x.c, ["securityContext", "allowPrivilegeEscalation"], true) != false
	msg := sprintf("no-privilege-escalation: %s container %s must set securityContext.allowPrivilegeEscalation: false", [name(x.obj), x.c.name])
}

# Non-root: runAsNonRoot on the container or its pod, and no user 0 at either level.
deny contains msg if {
	some x in containers
	object.get(x.c, ["securityContext", "runAsNonRoot"], object.get(x.pod, ["securityContext", "runAsNonRoot"], false)) != true
	msg := sprintf("non-root: %s container %s must run with runAsNonRoot: true (container or pod)", [name(x.obj), x.c.name])
}

deny contains msg if {
	some x in containers
	object.get(x.c, ["securityContext", "runAsUser"], object.get(x.pod, ["securityContext", "runAsUser"], -1)) == 0
	msg := sprintf("non-root: %s container %s runs as user 0", [name(x.obj), x.c.name])
}

deny contains msg if {
	some p in pod_specs
	some field in ["hostNetwork", "hostPID", "hostIPC"]
	p.spec[field] == true
	msg := sprintf("no-host-namespaces: %s sets %s", [name(p.obj), field])
}

# --- Resources -------------------------------------------------------------------------------

deny contains msg if {
	some x in containers
	not x.c.resources.limits.memory
	msg := sprintf("resources: %s container %s has no memory limit", [name(x.obj), x.c.name])
}

deny contains msg if {
	some x in containers
	some resource in ["cpu", "memory"]
	not x.c.resources.requests[resource]
	msg := sprintf("resources: %s container %s has no %s request", [name(x.obj), x.c.name, resource])
}

# --- Images ----------------------------------------------------------------------------------

# The project's own images (any repository under its namespace), the Docker official images the
# cells and monitoring use, and the images of the upstream charts and manifests this repository
# configures (Phase 7). An image is a repository followed by its tag (`:`) or digest (`@`).
project_namespace := "ghcr.io/vananhdhj/shopify-devops/"

allowed_repositories := {
	"postgres",
	"redis",
	"python",
	"docker.io/grafana/loki",
	"docker.io/grafana/alloy",
	"docker.io/bitnami/sealed-secrets-controller",
	"docker.io/grafana/tempo",
	"quay.io/prometheus-operator/prometheus-config-reloader",
}

deny contains msg if {
	some x in containers
	not allowed_image(x.c.image)
	msg := sprintf("approved-registries: %s container %s uses %s, from no approved repository", [name(x.obj), x.c.name, x.c.image])
}

allowed_image(image) if startswith(image, project_namespace)

allowed_image(image) if {
	some repository in allowed_repositories
	some separator in [":", "@"]
	startswith(image, concat("", [repository, separator]))
}

deny contains msg if {
	some x in containers
	not regex.match(`@sha256:[0-9a-f]{64}$`, x.c.image)
	msg := sprintf("pinned-images: %s container %s uses %s, not pinned by digest", [name(x.obj), x.c.name, x.c.image])
}

deny contains msg if {
	some x in containers
	regex.match(`:latest(@|$)`, x.c.image)
	msg := sprintf("pinned-images: %s container %s uses a latest tag", [name(x.obj), x.c.name])
}

# --- Secrets ---------------------------------------------------------------------------------

# Secret values never live in Git: the cluster's come from `make secrets` (and, from ticket 04,
# from SealedSecrets, which are encrypted).
deny contains msg if {
	input.kind == "Secret"
	msg := sprintf("no-plain-secrets: %s is a plain Secret in Git", [name(input)])
}

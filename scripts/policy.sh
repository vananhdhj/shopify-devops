#!/usr/bin/env bash
# The manifest policies (Phase 7, ticket 01): Conftest over every rendered manifest and the Argo CD
# Applications, then the policy's own fixtures. Each file in policy/fixtures/fail must be denied
# by the rule its name starts with (`<rule>[--<case>].yaml`); policy/fixtures/pass must pass.
# Uses `conftest` from PATH (CI installs it), or else the pinned image.
#   policy.sh [rendered-dir]       default .local/rendered (under the repository, for the image)
set -euo pipefail
out="${1:-.local/rendered}"
image="openpolicyagent/conftest@sha256:0e77cdf7c1fcde035f3c579e4aaa6664ee2a8be5777eaa9af9f520cdd02280c0" # v0.71.1
conftest() {
  if type -P conftest >/dev/null; then
    command conftest "$@"
  else
    docker run --rm -v "$PWD:/repo:ro" -w /repo "$image" "$@"
  fi
}

scripts/render-manifests.sh "$out"
conftest test --no-color --policy policy "$out" deploy/argocd/*.yaml deploy/monitoring/application.yaml

conftest test --no-color --policy policy policy/fixtures/pass >/dev/null || { echo "policy: a passing fixture was denied" >&2; exit 1; }
failed=0
for fixture in policy/fixtures/fail/*.yaml; do
  rule="$(basename "$fixture" .yaml)"
  rule="${rule%%--*}"
  if output="$(conftest test --no-color --policy policy "$fixture" 2>&1)"; then
    echo "policy: $fixture was not denied" >&2; failed=1
  elif ! grep -q -- "- main - $rule:" <<<"$output"; then
    echo "policy: $fixture was denied, but not by $rule:" >&2; echo "$output" >&2; failed=1
  fi
done
[ "$failed" = 0 ] || exit 1
echo "policy: $(ls policy/fixtures/fail/*.yaml | wc -l | tr -d ' ') failing fixtures each denied by their rule; the passing fixture passes"

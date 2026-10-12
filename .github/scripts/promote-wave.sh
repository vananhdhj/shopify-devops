#!/usr/bin/env bash
# Promotion (Phase 4): points every cell of a wave at the image digests the previous wave runs.
# Run by the promote workflow, from a checkout of main; it only edits files, the workflow commits.
#   promote-wave.sh <wave> [digests]
# <digests> is the JSON object the promoter gated, {"<image>": "sha256:…"}; empty means the previous
# wave's own pins (the operator's manual fallback). Refuses, changing nothing, unless every cell
# of the previous wave runs exactly these digests, so a promotion can only ever move a digest set
# one wave on, never introduce one. Changing nothing at all is fine: the wave already runs them.
set -euo pipefail

wave="${1:-}"
digests="${2:-}"
cells_dir="${CELLS_DIR:-deploy/cells/dev}"
fail() { echo "promote: $*" >&2; exit 1; }

[[ "$wave" =~ ^[1-9][0-9]?$ ]] || fail "wave must be 1 or later, not '$wave' (wave 0 gets every release from the release workflow)"

cells_of() {
  local file
  for file in "$cells_dir"/*/cell.json; do
    [ "$(jq -r .wave "$file")" = "$1" ] && dirname "$file"
  done
  return 0
}
# A cell's pins as {"<image>": "<digest>"}, keys sorted so two cells' pins compare as text.
pins_of() { yq -o=json -I=0 '[.images[] | {"key": .name, "value": .digest}] | from_entries' "$1/kustomization.yaml" | jq -cS .; }

mapfile -t targets < <(cells_of "$wave")
mapfile -t sources < <(cells_of "$((wave - 1))")
[ "${#targets[@]}" -gt 0 ] || fail "no cell is in wave $wave"
[ "${#sources[@]}" -gt 0 ] || fail "no cell is in wave $((wave - 1))"

reference="$(pins_of "${sources[0]}")"
for cell in "${sources[@]}"; do
  [ "$(pins_of "$cell")" = "$reference" ] || fail "the cells of wave $((wave - 1)) run different digests; promote when they agree"
done
[ -n "$digests" ] || digests="$reference"
jq -e 'type == "object" and length > 0 and all(.[]; type == "string" and test("^sha256:[0-9a-f]{64}$"))' <<<"$digests" >/dev/null ||
  fail "digests must be a JSON object of image to sha256 digest"
jq -e --argjson ref "$reference" 'to_entries | all(.value == $ref[.key])' <<<"$digests" >/dev/null ||
  fail "wave $((wave - 1)) does not run exactly these digests: $(jq -c --argjson ref "$reference" 'with_entries(select(.value != $ref[.key]))' <<<"$digests")"

for cell in "${targets[@]}"; do
  while IFS=$'\t' read -r image digest; do
    export IMAGE="$image" DIGEST="$digest"
    if yq -e '.images[] | select(.name == strenv(IMAGE))' "$cell/kustomization.yaml" >/dev/null 2>&1; then
      yq -i '(.images[] | select(.name == strenv(IMAGE))).digest = strenv(DIGEST)' "$cell/kustomization.yaml"
    else
      yq -i '.images += [{"name": strenv(IMAGE), "digest": strenv(DIGEST)}]' "$cell/kustomization.yaml"
    fi
  done < <(jq -r 'to_entries[] | [.key, .value] | @tsv' <<<"$digests")
  echo "promote: $(basename "$cell") (wave $wave) pinned to wave $((wave - 1))'s digests"
done

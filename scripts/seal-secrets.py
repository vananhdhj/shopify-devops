#!/usr/bin/env python3
"""Seals the cluster's Secrets for Git (Phase 7, ticket 04).

Each Secret that the lab cluster's units read is built from `.secrets/` (written by
`scripts/secrets.sh`), as `scripts/cluster-secrets.sh` used to apply it. It is encrypted with
kubeseal (the pinned image) against the controller's public certificate
(`deploy/sealed-secrets/cert.pem`), so sealing needs no cluster, and written beside the
manifests of the Application that deploys it. Only the controller's private key, in the
cluster and in the backup `make seal-key-backup` writes to `.secrets/`, can decrypt them.

Sealing is randomised, so a Secret is re-sealed only when its values change: each sealed file
records a keyed hash of its plaintext (HMAC-SHA256, keyed by `.secrets/seal-hmac-key`, which never
leaves the laptop), and an unchanged Secret keeps its file as it is.

    seal-secrets.py             seal what changed
    seal-secrets.py --verify    compare each Secret in the cluster with the local values, by hash
                                (never printing one), before the controller takes them over
"""
import base64
import hashlib
import hmac
import json
import os
import pathlib
import secrets
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SECRETS = ROOT / ".secrets"
CERT = ROOT / "deploy/sealed-secrets/cert.pem"
KUBESEAL = "bitnami/sealed-secrets-kubeseal@sha256:3401dfa2e51877380ede1364ca0a02442c1db1c00adf52a33f1c67815750805d"  # 0.40.0
ANNOTATION = "shop.example/sealed-from"
PART_OF = {"app.kubernetes.io/part-of": "shop"}


def env_file(path: pathlib.Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value
    return values


def credential_files(directory: pathlib.Path) -> dict[str, str]:
    """One key per file, `<cell>.<key>`; the integration tests' throwaway cells (test-*) stay local."""
    return {f.name: f.read_text() for f in sorted(directory.iterdir()) if f.is_file() and not f.name.startswith("test-")}


def cluster_secrets() -> list[dict]:
    """Every Secret the lab cluster reads: (namespace, name, labels, data, the file it is sealed to)."""
    dev = env_file(SECRETS / "dev.env")
    out = []
    for cell_json in sorted((ROOT / "deploy/cells/dev").glob("*/cell.json")):
        cell = cell_json.parent.name
        namespace = json.loads(cell_json.read_text())["namespace"]
        out.append(dict(namespace=namespace, name="shop-secrets", labels=PART_OF,
                        data=env_file(SECRETS / "cells" / f"{cell}.env"),
                        file=cell_json.parent / "sealed-shop-secrets.yaml"))
    platform_keys = {k: v for k, v in dev.items()
                     if k.startswith("DB_PLATFORM_") or (k.startswith("PLATFORM_") and k.endswith("_TOKEN"))
                     or k in ("MERCHANT_CREDENTIALS", "GITHUB_PROMOTE_TOKEN")}
    platform = ROOT / "deploy/platform/overlays/dev"
    edge = ROOT / "deploy/edge/overlays/dev"
    monitoring = ROOT / "deploy/monitoring/config"
    out += [
        dict(namespace="platform-dev", name="platform-secrets", labels=PART_OF, data=platform_keys,
             file=platform / "sealed-platform-secrets.yaml"),
        dict(namespace="platform-dev", name="cell-credentials", labels=PART_OF,
             data=credential_files(SECRETS / "mounts/platform"), file=platform / "sealed-cell-credentials.yaml"),
        dict(namespace="edge-dev", name="edge-secrets", labels=PART_OF,
             data={"PLATFORM_ROUTER_TOKEN": dev["PLATFORM_ROUTER_TOKEN"]}, file=edge / "sealed-edge-secrets.yaml"),
        dict(namespace="edge-dev", name="cell-credentials", labels=PART_OF,
             data=credential_files(SECRETS / "mounts/edge"), file=edge / "sealed-cell-credentials.yaml"),
        dict(namespace="monitoring", name="grafana-admin", labels={},
             data={"admin-user": "admin", "admin-password": dev["GRAFANA_ADMIN_PASSWORD"]},
             file=monitoring / "sealed-grafana-admin.yaml"),
        dict(namespace="monitoring", name="alertmanager-discord", labels={},
             data={"url": dev.get("DISCORD_WEBHOOK_URL") or "https://discord.invalid/not-configured"},
             file=monitoring / "sealed-alertmanager-discord.yaml"),
    ]
    return out


def hmac_key() -> bytes:
    path = SECRETS / "seal-hmac-key"
    if not path.exists():
        path.write_text(secrets.token_hex(32))
        path.chmod(0o600)
    return bytes.fromhex(path.read_text().strip())


def fingerprint(secret: dict) -> str:
    canonical = json.dumps([secret["namespace"], secret["name"], secret["labels"], secret["data"]], sort_keys=True)
    return hmac.new(hmac_key(), canonical.encode(), hashlib.sha256).hexdigest()


def recorded(path: pathlib.Path) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        if line.strip().startswith(f"{ANNOTATION}:"):
            return line.split(":", 1)[1].strip()
    return None


def as_yaml(sealed: dict, mark: str, header: str) -> str:
    """The sealed object as YAML; every value is a plain string, so a small emitter is enough."""
    meta = sealed["metadata"]
    template = sealed["spec"]["template"]["metadata"]
    lines = [header, "apiVersion: bitnami.com/v1alpha1", "kind: SealedSecret", "metadata:",
             f"  name: {meta['name']}", f"  namespace: {meta['namespace']}", "  annotations:",
             f"    {ANNOTATION}: {mark}", "spec:", "  encryptedData:"]
    lines += [f"    {key}: {value}" for key, value in sorted(sealed["spec"]["encryptedData"].items())]
    lines += ["  template:", "    metadata:", f"      name: {template['name']}", f"      namespace: {template['namespace']}"]
    if template.get("labels"):
        lines.append("      labels:")
        lines += [f"        {key}: {value}" for key, value in sorted(template["labels"].items())]
    lines.append("    type: Opaque")
    return "\n".join(lines) + "\n"


def seal(secret: dict) -> bool:
    mark = fingerprint(secret)
    if recorded(secret["file"]) == mark:
        return False
    plain = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
             "metadata": {"name": secret["name"], "namespace": secret["namespace"], **({"labels": secret["labels"]} if secret["labels"] else {})},
             "stringData": secret["data"]}
    sealed = subprocess.run(
        ["docker", "run", "--rm", "-i", "-v", f"{CERT.parent}:/cert:ro", KUBESEAL, "--cert", "/cert/cert.pem", "--format", "json"],
        input=json.dumps(plain), capture_output=True, text=True, check=True,
    ).stdout
    header = (f"# {secret['namespace']}/{secret['name']}, sealed by scripts/seal-secrets.py (`make secrets`) against\n"
              "# deploy/sealed-secrets/cert.pem; only the cluster's controller can decrypt it. Regenerated, never edited.")
    secret["file"].write_text(as_yaml(json.loads(sealed), mark, header))
    return True


def verify(secrets_list: list[dict]) -> int:
    """Compares each live Secret's values with the local ones, by sha256 only."""
    digest = lambda value: hashlib.sha256(value.encode()).hexdigest()
    differing = 0
    for secret in secrets_list:
        result = subprocess.run(["kubectl", "-n", secret["namespace"], "get", "secret", secret["name"], "-o", "json"],
                                capture_output=True, text=True)
        if result.returncode != 0:
            print(f"{secret['namespace']}/{secret['name']}: not in the cluster")
            differing += 1
            continue
        live = {k: digest(base64.b64decode(v).decode()) for k, v in (json.loads(result.stdout).get("data") or {}).items()}
        local = {k: digest(v) for k, v in secret["data"].items()}
        keys = sorted(set(live) | set(local))
        bad = [k for k in keys if live.get(k) != local.get(k)]
        print(f"{secret['namespace']}/{secret['name']}: {len(keys)} keys, " + (f"DIFFERENT: {', '.join(bad)}" if bad else "equal"))
        differing += bool(bad)
    return differing


def main() -> int:
    secrets_list = cluster_secrets()
    if "--verify" in sys.argv:
        return 1 if verify(secrets_list) else 0
    changed = [s for s in secrets_list if seal(s)]
    for s in secrets_list:
        state = "sealed" if s in changed else "unchanged"
        print(f"{s['namespace']}/{s['name']}: {state} ({s['file'].relative_to(ROOT)})")
    return 0


if __name__ == "__main__":
    os.chdir(ROOT)
    sys.exit(main())

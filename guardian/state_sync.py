"""Keep Guardian's runtime state (the household store and gren's run store, both plain files under `var/`) in S3.

AgentCore Runtime containers are ephemeral and the dashboard may run elsewhere, so every invocation pulls the state
down first and pushes what changed back at the end. A manifest of MD5 sums per file keeps the sync incremental in both
directions; files that vanish locally are deleted remotely and vice versa. Small trees (hundreds of files) sync in a
second or two, which is what a household produces."""
from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Iterable

MANIFEST = ".guardian-sync.json"
SKIP_DIRS = {"__pycache__", ".tmp"}


def _md5(path: str) -> str:
    h = hashlib.md5()  # noqa: S324 - content fingerprint, not security
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def local_manifest(root: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn == MANIFEST or fn.endswith(".tmp"):
                continue
            p = os.path.join(dirpath, fn)
            out[os.path.relpath(p, root).replace(os.sep, "/")] = _md5(p)
    return out


class S3StateSync:
    """Two-way file sync between a local directory tree and an S3 prefix, driven by content hashes."""

    def __init__(self, bucket: str, prefix: str, root: str, client: Any | None = None):
        self.bucket, self.prefix, self.root = bucket, prefix.strip("/"), os.path.abspath(root)
        if client is None:
            import boto3  # type: ignore

            client = boto3.client("s3")
        self.s3 = client

    # ---- remote manifest
    def _key(self, rel: str) -> str:
        return f"{self.prefix}/{rel}" if self.prefix else rel

    def remote_manifest(self) -> dict[str, str] | None:
        """The manifest of the last push, or None when this prefix has never been pushed."""
        try:
            body = self.s3.get_object(Bucket=self.bucket, Key=self._key(MANIFEST))["Body"].read()
            data = json.loads(body)
            return data if isinstance(data, dict) else {}
        except Exception as e:  # noqa: BLE001 - NoSuchKey or an empty bucket
            if e.__class__.__name__ not in ("NoSuchKey", "ClientError", "NoSuchBucket"):
                raise
            return None

    def _put_manifest(self, manifest: dict[str, str]) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=self._key(MANIFEST), Body=json.dumps(manifest, sort_keys=True).encode("utf-8"), ContentType="application/json")

    # ---- operations
    def pull(self) -> dict[str, Any]:
        """Make the local tree match S3: download new or changed files, delete local files S3 no longer has."""
        t0 = time.time()
        remote, local = self.remote_manifest(), local_manifest(self.root)
        if remote is None:
            return {"downloaded": 0, "deleted": 0, "files": 0, "ms": int((time.time() - t0) * 1000), "note": "nothing pushed to this prefix yet; local state kept"}
        downloaded, deleted = 0, 0
        for rel, digest in remote.items():
            if local.get(rel) == digest:
                continue
            dest = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            body = self.s3.get_object(Bucket=self.bucket, Key=self._key(rel))["Body"].read()
            with open(dest, "wb") as f:
                f.write(body)
            downloaded += 1
        for rel in local:
            if rel not in remote:
                try:
                    os.remove(os.path.join(self.root, rel))
                    deleted += 1
                except OSError:
                    pass
        return {"downloaded": downloaded, "deleted": deleted, "files": len(remote), "ms": int((time.time() - t0) * 1000)}

    def push(self) -> dict[str, Any]:
        """Make S3 match the local tree: upload new or changed files, delete remote files that no longer exist locally."""
        t0 = time.time()
        remote, local = self.remote_manifest() or {}, local_manifest(self.root)
        uploaded, deleted = 0, 0
        for rel, digest in local.items():
            if remote.get(rel) == digest:
                continue
            with open(os.path.join(self.root, rel), "rb") as f:
                self.s3.put_object(Bucket=self.bucket, Key=self._key(rel), Body=f.read())
            uploaded += 1
        for rel in remote:
            if rel not in local:
                self.s3.delete_object(Bucket=self.bucket, Key=self._key(rel))
                deleted += 1
        self._put_manifest(local)
        return {"uploaded": uploaded, "deleted": deleted, "files": len(local), "ms": int((time.time() - t0) * 1000)}


def sync_targets_from_env(data_dir: str, runs_dir: str) -> list[S3StateSync]:
    """The two trees Guardian keeps, when GUARDIAN_S3_BUCKET is set; otherwise nothing to sync."""
    bucket = os.environ.get("GUARDIAN_S3_BUCKET", "").strip()
    if not bucket:
        return []
    prefix = os.environ.get("GUARDIAN_S3_PREFIX", "guardian").strip("/")
    return [S3StateSync(bucket, f"{prefix}/household", data_dir), S3StateSync(bucket, f"{prefix}/runs", runs_dir)]


def pull_all(targets: Iterable[S3StateSync]) -> list[dict[str, Any]]:
    return [t.pull() for t in targets]


def push_all(targets: Iterable[S3StateSync]) -> list[dict[str, Any]]:
    return [t.push() for t in targets]

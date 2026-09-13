"""S3 state sync against an in-memory stand-in for the S3 client (same call shapes as boto3)."""
import io
import os

from guardian.state_sync import MANIFEST, S3StateSync, local_manifest


class FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise type("NoSuchKey", (Exception,), {})(Key)
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, **kw):
        self.objects[Key] = Body if isinstance(Body, bytes) else Body.read()

    def delete_object(self, Bucket, Key):
        self.objects.pop(Key, None)


def _write(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def test_push_then_pull_round_trip_is_incremental(tmp_path):
    s3 = FakeS3()
    a = str(tmp_path / "a")
    b = str(tmp_path / "b")
    _write(a, "items.json", "[1]")
    _write(a, "outbox/sms-1.json", "{}")
    _write(a, "runs/r1/events.jsonl", "e1\n")
    up = S3StateSync("bkt", "guardian/household", a, client=s3).push()
    assert up["uploaded"] == 3 and up["deleted"] == 0 and "guardian/household/" + MANIFEST in s3.objects
    down = S3StateSync("bkt", "guardian/household", b, client=s3).pull()
    assert down["downloaded"] == 3 and local_manifest(a) == local_manifest(b)
    # second push with one change and one deletion
    _write(a, "items.json", "[1,2]")
    os.remove(os.path.join(a, "outbox", "sms-1.json"))
    up2 = S3StateSync("bkt", "guardian/household", a, client=s3).push()
    assert up2["uploaded"] == 1 and up2["deleted"] == 1
    down2 = S3StateSync("bkt", "guardian/household", b, client=s3).pull()
    assert down2["downloaded"] == 1 and down2["deleted"] == 1
    assert local_manifest(a) == local_manifest(b)
    assert not os.path.exists(os.path.join(b, "outbox", "sms-1.json"))
    # nothing to do when in sync
    assert S3StateSync("bkt", "guardian/household", a, client=s3).push()["uploaded"] == 0
    assert S3StateSync("bkt", "guardian/household", b, client=s3).pull()["downloaded"] == 0


def test_pull_from_a_never_pushed_prefix_keeps_local_state(tmp_path):
    s3 = FakeS3()
    root = str(tmp_path / "x")
    os.makedirs(root)
    _write(root, "prefs.json", "{}")
    res = S3StateSync("bkt", "p", root, client=s3).pull()
    assert res["downloaded"] == 0 and res["deleted"] == 0 and os.path.exists(os.path.join(root, "prefs.json"))


def test_guardian_pushes_after_changes_only_with_state_sync_on(tmp_path, monkeypatch, demo):
    """A server with GUARDIAN_STATE_SYNC=1 mirrors its store to the bucket after every change; a developer's machine
    with only GUARDIAN_S3_BUCKET in .env must never touch S3."""
    from guardian import service as svc

    s3 = FakeS3()
    monkeypatch.setattr(svc, "sync_targets_from_env", lambda data_dir, runs_dir: [S3StateSync("bkt", "guardian/household", data_dir, client=s3)])
    monkeypatch.setenv("GUARDIAN_DATA", str(tmp_path / "a"))
    monkeypatch.setenv("GUARDIAN_RUNS", str(tmp_path / "a-runs"))
    monkeypatch.delenv("GUARDIAN_STATE_SYNC", raising=False)
    g, _ = svc.Guardian.build(data_dir=str(tmp_path / "a"), runs_dir=str(tmp_path / "a-runs"), bridge="mock", with_gren_app=False)
    g.add_item(demo["items"][0], source="seed")
    assert s3.objects == {} and g.summary()["runtime"]["state_sync"] is False
    monkeypatch.setenv("GUARDIAN_STATE_SYNC", "1")
    g, _ = svc.Guardian.build(data_dir=str(tmp_path / "b"), runs_dir=str(tmp_path / "b-runs"), bridge="mock", with_gren_app=False)
    g.add_item(demo["items"][0], source="seed")
    assert "guardian/household/items.json" in s3.objects and g.summary()["runtime"]["state_sync"] is True
    # a fresh process (a replaced instance) starts from the bucket copy
    g2, _ = svc.Guardian.build(data_dir=str(tmp_path / "c"), runs_dir=str(tmp_path / "c-runs"), bridge="mock", with_gren_app=False)
    assert [i.id for i in g2.store.items()] == [demo["items"][0]["id"]]

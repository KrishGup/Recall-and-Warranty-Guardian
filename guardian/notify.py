"""Outbound channels. SNS for SMS and SES for email when configured (GUARDIAN_SNS=1 / GUARDIAN_SES_FROM with AWS
credentials and the `aws` extra); otherwise every message is written to the household outbox so the demo and the
tests can show exactly what would have gone out."""
from __future__ import annotations

import os
import re
from typing import Any

from .models import now_iso
from .store import Store


def mask_phone(phone: str | None) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return f"···{digits[-4:]}" if len(digits) >= 4 else "no phone on file"


class Notifier:
    def __init__(self, store: Store):
        self.store = store

    def sms(self, to: str | None, body: str, ref: dict[str, Any] | None = None) -> dict[str, Any]:
        if os.environ.get("GUARDIAN_SNS") == "1" and to:
            try:
                import boto3  # type: ignore

                r = boto3.client("sns").publish(PhoneNumber=to, Message=body)
                return {"channel": "sms", "to": mask_phone(to), "delivered": True, "note": "sent via SNS", "message_id": r.get("MessageId"), "at": now_iso()}
            except Exception as e:  # noqa: BLE001
                path = self.store.outbox_write("sms", {"to": to, "body": body, "ref": ref or {}, "error": str(e)})
                return {"channel": "sms", "to": mask_phone(to), "delivered": False, "note": f"SNS failed ({e.__class__.__name__}); written to outbox", "outbox": path, "at": now_iso()}
        path = self.store.outbox_write("sms", {"to": to, "body": body, "ref": ref or {}})
        return {"channel": "sms", "to": mask_phone(to), "delivered": False, "note": "SNS not configured; written to outbox", "outbox": path, "at": now_iso()}

    def email(self, to: str | None, subject: str, body: str, attachments: list[str] | None = None, ref: dict[str, Any] | None = None) -> dict[str, Any]:
        sender = os.environ.get("GUARDIAN_SES_FROM")
        if sender and to:
            try:
                import boto3  # type: ignore

                r = boto3.client("ses").send_email(Source=sender, Destination={"ToAddresses": [to]}, Message={"Subject": {"Data": subject}, "Body": {"Text": {"Data": body}}})
                return {"channel": "email", "to": to, "delivered": True, "note": "sent via SES", "message_id": r.get("MessageId"), "attachments": attachments or [], "at": now_iso()}
            except Exception as e:  # noqa: BLE001
                path = self.store.outbox_write("email", {"to": to, "subject": subject, "body": body, "attachments": attachments or [], "ref": ref or {}, "error": str(e)})
                return {"channel": "email", "to": to, "delivered": False, "note": f"SES failed ({e.__class__.__name__}); written to outbox", "outbox": path, "at": now_iso()}
        path = self.store.outbox_write("email", {"to": to, "subject": subject, "body": body, "attachments": attachments or [], "ref": ref or {}})
        return {"channel": "email", "to": to, "delivered": False, "note": "SES not configured; written to outbox", "outbox": path, "at": now_iso()}

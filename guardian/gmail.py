"""Gmail connectivity (BUILD_PLAN.md section 3.1.1): OAuth2 authorization-code flow against Google's endpoints plus
the minimum of the Gmail REST API needed to pull receipt-shaped messages for the intake pipeline. Guardian never
handles a Gmail password: only the OAuth grant, `gmail.readonly`, stored as a refresh token in `var/household/gmail.json`.

Requires the household's own Google Cloud OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env); see
.env.example for how to create one. Without it, `configured()` is False and callers should fall back to the
zero-OAuth forwarding-filter path (Preferences.forwarding_address)."""
from __future__ import annotations

import base64
import os
import time
from typing import Any
from urllib.parse import urlencode

import httpx

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me"
SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
# BUILD_PLAN.md 3.1.2: the merchants and services most likely to carry a parseable receipt.
DEFAULT_SENDERS = ["amazon.com", "shopify", "target.com", "walmart.com", "bestbuy.com", "instacart.com", "homedepot.com", "costco.com"]
DEFAULT_QUERY = "newer_than:365d (" + " OR ".join(f"from:{s}" for s in DEFAULT_SENDERS) + ' OR subject:(receipt OR "order confirmation" OR "your order"))'


def client_id() -> str:
    return os.environ.get("GOOGLE_CLIENT_ID", "").strip()


def client_secret() -> str:
    return os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()


def redirect_uri() -> str:
    return os.environ.get("GOOGLE_REDIRECT_URI", "").strip() or "http://127.0.0.1:8787/api/gmail/callback"


def configured() -> bool:
    return bool(client_id() and client_secret())


def auth_url(state: str) -> str:
    params = {
        "client_id": client_id(),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code(code: str) -> dict[str, Any]:
    """Authorization code -> {access_token, refresh_token, expires_in, ...}. Called once, right after the redirect."""
    with httpx.Client(timeout=20) as c:
        r = c.post(TOKEN_URL, data={"code": code, "client_id": client_id(), "client_secret": client_secret(), "redirect_uri": redirect_uri(), "grant_type": "authorization_code"})
        r.raise_for_status()
        return r.json()


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    with httpx.Client(timeout=20) as c:
        r = c.post(TOKEN_URL, data={"refresh_token": refresh_token, "client_id": client_id(), "client_secret": client_secret(), "grant_type": "refresh_token"})
        r.raise_for_status()
        return r.json()


def get_profile(access_token: str) -> dict[str, Any]:
    with httpx.Client(timeout=20) as c:
        r = c.get(f"{API_ROOT}/profile", headers={"Authorization": f"Bearer {access_token}"})
        r.raise_for_status()
        return r.json()


def list_message_ids(access_token: str, query: str = DEFAULT_QUERY, max_results: int = 25) -> list[str]:
    with httpx.Client(timeout=30) as c:
        r = c.get(f"{API_ROOT}/messages", headers={"Authorization": f"Bearer {access_token}"}, params={"q": query, "maxResults": max_results})
        r.raise_for_status()
        return [m["id"] for m in r.json().get("messages", [])]


def _decode_part(data: str) -> str:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")


def _find_text(payload: dict[str, Any]) -> str:
    body = payload.get("body") or {}
    if body.get("data") and payload.get("mimeType") in ("text/plain", "text/html"):
        return _decode_part(body["data"])
    for part in payload.get("parts") or []:
        if part.get("mimeType") == "text/plain" and (part.get("body") or {}).get("data"):
            return _decode_part(part["body"]["data"])
    for part in payload.get("parts") or []:
        text = _find_text(part)
        if text:
            return text
    return ""


def get_message(access_token: str, message_id: str) -> dict[str, Any]:
    """One message as {gmail_message_id, subject, from, date, text}. `text` is the plain-text body when the message
    has one, else the raw HTML part (the intake LLM strips markup fine), else the Gmail-provided snippet."""
    with httpx.Client(timeout=30) as c:
        r = c.get(f"{API_ROOT}/messages/{message_id}", headers={"Authorization": f"Bearer {access_token}"}, params={"format": "full"})
        r.raise_for_status()
        msg = r.json()
    headers = {h["name"].lower(): h["value"] for h in (msg.get("payload") or {}).get("headers", [])}
    text = _find_text(msg.get("payload") or {}) or msg.get("snippet", "")
    return {"gmail_message_id": message_id, "subject": headers.get("subject", ""), "from": headers.get("from", ""), "date": headers.get("date", ""), "text": text}


def valid_access_token(tokens: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Returns a usable access token, refreshing first if it is missing or has expired; the second element is the
    (possibly updated) token record the caller should persist."""
    if tokens.get("access_token") and float(tokens.get("expires_at") or 0) > time.time() + 30:
        return str(tokens["access_token"]), tokens
    fresh = refresh_access_token(str(tokens["refresh_token"]))
    updated = {**tokens, "access_token": fresh["access_token"], "expires_at": time.time() + float(fresh.get("expires_in") or 3600)}
    return str(fresh["access_token"]), updated

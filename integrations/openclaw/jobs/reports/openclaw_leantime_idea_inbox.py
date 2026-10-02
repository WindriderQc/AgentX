#!/usr/bin/env python3
"""Read the owner's Leantime idea inbox for deterministic OpenClaw delivery."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

API_KEY_FILES = (
    Path.home() / "leantime-nestor-apikey.txt",
    Path.home() / ".leantime-nestor-apikey",
)
RPC_METHOD = "leantime.rpc.Tickets.getAllOpenUserTickets"
MAX_ITEMS = 50
MAX_OUTPUT_CHARS = 7000


class LeantimeInboxError(RuntimeError):
    """The bounded read-only Leantime request failed."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse redirects so the Leantime key never crosses an origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N803
        return None


def api_key(paths: tuple[Path, ...] = API_KEY_FILES) -> str:
    for path in paths:
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return value
    raise LeantimeInboxError("Leantime credential is unavailable")


def api_key_paths(configured: str = "") -> tuple[Path, ...]:
    configured = (configured or os.environ.get("LEANTIME_API_KEY_FILE", "")).strip()
    return (Path(configured).expanduser(),) if configured else API_KEY_FILES


def jsonrpc_url(raw: str | None = None) -> str:
    url = (raw if raw is not None else os.environ.get("LEANTIME_JSONRPC_URL", "")).strip()
    if not url:
        raise LeantimeInboxError("Leantime JSON-RPC URL is not configured")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise LeantimeInboxError("Leantime JSON-RPC URL is invalid")
    return url


def user_id(raw: str | None = None) -> int:
    raw = (raw if raw is not None else os.environ.get("LEANTIME_IDEA_USER_ID", "")).strip()
    if not raw:
        raise LeantimeInboxError("Leantime user id is not configured")
    try:
        value = int(raw)
    except ValueError as error:
        raise LeantimeInboxError("Leantime user id is invalid") from error
    if value <= 0:
        raise LeantimeInboxError("Leantime user id is invalid")
    return value


def fetch_items(
    url: str,
    *,
    owner_id: int,
    credential_paths: tuple[Path, ...] = API_KEY_FILES,
    timeout: int = 15,
) -> list[dict[str, Any]]:
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method": RPC_METHOD,
        "id": 1,
        "params": {"userId": owner_id},
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "x-api-key": api_key(credential_paths),
        },
        method="POST",
    )
    try:
        with urllib.request.build_opener(NoRedirectHandler()).open(request, timeout=timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        raise LeantimeInboxError(f"Leantime returned HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise LeantimeInboxError("Leantime idea inbox is unavailable") from error
    if not isinstance(body, dict) or body.get("error") is not None or not isinstance(body.get("result"), list):
        raise LeantimeInboxError("Leantime returned an invalid JSON-RPC response")
    items = body["result"]
    if any(not isinstance(item, dict) for item in items):
        raise LeantimeInboxError("Leantime returned an invalid ticket list")
    return items[:MAX_ITEMS]


def clean_text(value: Any, fallback: str = "sans titre") -> str:
    text = " ".join(str(value or "").split()).strip()
    return (text or fallback)[:240]


def render(items: list[dict[str, Any]], source_host: str = "") -> str:
    lines = ["📝 Liste d'idées — Leantime", ""]
    if not items:
        lines.append("(inbox vide)")
    else:
        for item in items:
            headline = clean_text(item.get("headline"))
            project = clean_text(item.get("projectName"), "projet inconnu")
            ticket_id = clean_text(item.get("id"), "id inconnu")
            lines.append(f"• {headline}   (#{ticket_id} · {project})")
        source = f"Leantime @ {source_host}" if source_host else "Leantime"
        lines.extend(("", f"{len(items)} idée(s) ouverte(s) · source : {source}"))
    output = "\n".join(lines)
    return output if len(output) <= MAX_OUTPUT_CHARS else output[: MAX_OUTPUT_CHARS - 16].rstrip() + "\n…[tronqué]"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=None, help="Leantime JSON-RPC URL (default: LEANTIME_JSONRPC_URL)")
    parser.add_argument("--user-id", default=None, help="Leantime user id (default: LEANTIME_IDEA_USER_ID)")
    parser.add_argument("--api-key-file", default="", help="Leantime API key file (default: LEANTIME_API_KEY_FILE)")
    parser.add_argument("--timeout", type=int, default=15)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        url = jsonrpc_url(args.url)
        items = fetch_items(
            url,
            owner_id=user_id(args.user_id),
            credential_paths=api_key_paths(args.api_key_file),
            timeout=args.timeout,
        )
        print(render(items, urlsplit(url).hostname or ""))
        return 0
    except LeantimeInboxError as error:
        print(f"Liste d'idées (Leantime) indisponible: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

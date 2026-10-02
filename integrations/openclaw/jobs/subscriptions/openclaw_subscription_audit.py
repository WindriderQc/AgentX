#!/usr/bin/env python3
"""Run the AgentX subscription audit from OpenClaw with read-only Gmail data."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any


QUERY = (
    'newer_than:90d -in:spam -in:trash '
    '(subscription OR renewal OR receipt OR invoice OR trial OR newsletter OR '
    'unsubscribe OR cancellation OR cancelled OR "manage preferences")'
)
SOURCE = "Gmail read-only via gog on OpenClaw"
FIXTURE_SOURCE = "fixture-only / blocked on Gmail access"
COUNT_ORDER = (
    "validate_usage",
    "unsubscribe_candidate",
    "active_keep",
    "cancelled_or_done",
    "manual_review",
)
SUMMARY_FIELDS = ("from", "subject", "date")


class GmailAccessError(RuntimeError):
    """Raised when the bounded read-only Gmail search cannot complete."""


AUDIT_SCRIPT = Path(__file__).resolve().with_name("subscription-audit.js")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    env = os.environ
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workspace",
        default=env.get("SUBSCRIPTION_AUDIT_WORKSPACE")
        or str(Path.home() / ".openclaw" / "workspace"),
    )
    parser.add_argument("--audit-script", default=str(AUDIT_SCRIPT))
    parser.add_argument("--account", default=env.get("GMAIL_SECRETARY_ACCOUNT"))
    parser.add_argument("--gog", default=env.get("GMAIL_SECRETARY_GOG") or "gog")
    parser.add_argument("--node", default="node")
    parser.add_argument(
        "--keyring-password-file",
        default=env.get("GMAIL_SECRETARY_KEYRING_FILE")
        or str(Path.home() / ".config" / "gogcli" / "keyring-password"),
    )
    parser.add_argument("--timezone", default=env.get("GMAIL_SECRETARY_TIMEZONE") or "UTC")
    args = parser.parse_args(argv)
    if not args.account:
        parser.error("--account or GMAIL_SECRETARY_ACCOUNT is required")
    return args


def sanitized_messages(payload: Any) -> list[dict[str, Any]]:
    """Keep only the summary fields consumed by subscription-audit.js."""
    if isinstance(payload, dict):
        payload = payload.get("messages", payload.get("results", []))
    if not isinstance(payload, list):
        raise GmailAccessError("Gmail search returned an unexpected JSON shape")

    messages: list[dict[str, Any]] = []
    for raw in payload[:50]:
        if not isinstance(raw, dict):
            continue
        item = {field: raw.get(field, "") for field in SUMMARY_FIELDS}
        labels = raw.get("labels")
        item["labels"] = [str(label) for label in labels] if isinstance(labels, list) else []
        messages.append(item)
    return messages


def write_json_private(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        temp_path = Path(handle.name)
    temp_path.chmod(0o600)
    os.replace(temp_path, path)


def run_checked(command: list[str], *, env: dict[str, str], cwd: Path) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = " ".join((result.stderr or result.stdout).split())[:500]
        raise GmailAccessError(detail or f"command exited {result.returncode}")
    return result.stdout


def gmail_environment(password_file: Path) -> dict[str, str]:
    try:
        password = password_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise GmailAccessError(f"cannot read gog keyring password: {exc}") from exc
    if not password:
        raise GmailAccessError("gog keyring password is empty")
    env = os.environ.copy()
    env["GOG_KEYRING_BACKEND"] = "file"
    env["GOG_KEYRING_PASSWORD"] = password
    return env


def run_gmail_search(args: argparse.Namespace, workspace: Path) -> list[dict[str, Any]]:
    env = gmail_environment(Path(args.keyring_password_file))
    stdout = run_checked(
        [
            args.gog,
            "--readonly",
            "--gmail-no-send",
            "--no-input",
            "--json",
            "--results-only",
            "--enable-commands-exact=gmail.messages.search",
            "--account",
            args.account,
            "gmail",
            "messages",
            "search",
            QUERY,
            "--max",
            "50",
            "--timezone",
            args.timezone,
        ],
        env=env,
        cwd=workspace,
    )
    try:
        return sanitized_messages(json.loads(stdout))
    except json.JSONDecodeError as exc:
        raise GmailAccessError("Gmail search did not return valid JSON") from exc


def run_node_audit(
    args: argparse.Namespace,
    workspace: Path,
    report_dir: Path,
    input_path: Path,
    *,
    fixture: bool,
) -> dict[str, Any]:
    command = [
        args.node,
        args.audit_script,
        "run",
        "--report-dir",
        str(report_dir),
        "--state",
        str(report_dir / "state.json"),
        "--source",
        FIXTURE_SOURCE if fixture else SOURCE,
    ]
    command.extend(["--fixture"] if fixture else ["--input", str(input_path)])
    result = subprocess.run(command, cwd=workspace, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        detail = " ".join((result.stderr or result.stdout).split())[:500]
        raise RuntimeError(detail or f"subscription audit exited {result.returncode}")

    report_path = report_dir / "latest.html"
    summary_path = report_dir / "latest.summary.json"
    if not report_path.is_file() or not summary_path.is_file():
        raise RuntimeError("subscription audit did not generate latest.html and latest.summary.json")
    return json.loads(summary_path.read_text(encoding="utf-8"))


def print_result(
    *,
    status: str,
    message_count: int,
    report_dir: Path,
    summary: dict[str, Any],
    reason: str = "",
) -> None:
    print(f"Status: {status}")
    if reason:
        print(f"Reason: {reason}")
    print(f"Messages reviewed: {message_count}")
    print(f"Vendors: {len(summary.get('vendors') or [])}")
    counts = summary.get("counts") or {}
    print("Counts: " + ", ".join(f"{key}={int(counts.get(key, 0))}" for key in COUNT_ORDER))
    print(f"Report: {report_dir / 'latest.html'}")
    print(f"Summary: {report_dir / 'latest.summary.json'}")


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    args = parse_args(argv)
    workspace = Path(args.workspace).expanduser().resolve()
    report_dir = workspace / "reports" / "subscription-audit"
    input_path = report_dir / "input-gmail.json"
    workspace.mkdir(parents=True, exist_ok=True)

    try:
        messages = run_gmail_search(args, workspace)
        write_json_private(input_path, messages)
        summary = run_node_audit(
            args, workspace, report_dir, input_path, fixture=False
        )
        print_result(
            status="OK / Gmail read-only",
            message_count=len(messages),
            report_dir=report_dir,
            summary=summary,
        )
        return 0
    except GmailAccessError as exc:
        summary = run_node_audit(args, workspace, report_dir, input_path, fixture=True)
        print_result(
            status="FIXTURE-ONLY / BLOCKED ON GMAIL ACCESS",
            message_count=0,
            report_dir=report_dir,
            summary=summary,
            reason=str(exc),
        )
        return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - concise cron failure surface
        print(f"Status: FAILED\nReason: {exc}", file=sys.stderr)
        raise SystemExit(1)

"""Read-only Gmail transport with content-free, typed provider failures."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess


class GmailProviderError(RuntimeError):
    def __init__(self, command, returncode, kind="unknown"):
        super().__init__(f"Gmail {command} failed (exit {returncode}; {kind})")
        self.kind = kind
        self.returncode = returncode


def failure_kind(result):
    # Never persist stderr: provider failures can contain account data. An exit
    # code alone is not evidence that a source disappeared.
    detail = result.stderr or ""
    if re.search(r"\b(?:401|403)\b|invalid_grant|unauthorized|permission.denied", detail, re.I):
        return "authorization"
    if re.search(r"\b404\b.*(?:not.?found|requested entity)|\bnotFound\b", detail, re.I):
        return "not_found"
    if re.search(r"\b(?:429|500|502|503|504)\b|rate.limit|quota|timed?.?out", detail, re.I):
        return "transient"
    return "unknown"


def _run(command, exact, readonly):
    env = os.environ.copy()
    env["GOG_KEYRING_BACKEND"] = "file"
    password = Path(os.environ.get("GMAIL_SECRETARY_KEYRING_FILE", Path.home() / ".config/gogcli/keyring-password"))
    env["GOG_KEYRING_PASSWORD"] = password.read_text().strip()
    result = subprocess.run([
        os.environ.get("GMAIL_SECRETARY_GOG", "gog"), *(["--readonly"] if readonly else []), "--gmail-no-send",
        "--no-input", "--json", "--account=" + os.environ.get("GMAIL_SECRETARY_ACCOUNT", "auto"),
        f"--enable-commands-exact={exact}", *command,
    ], env=env, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise GmailProviderError(exact, result.returncode, failure_kind(result))
    return json.loads(result.stdout or "null")


def read_gmail(command):
    exact = "gmail.thread.get" if command[:3] == ["gmail", "thread", "get"] else (
        "gmail.attachment" if command[:2] == ["gmail", "attachment"] else (
            "gmail.labels.list" if command[:3] == ["gmail", "labels", "list"] else (
                "gmail.get" if command[:2] == ["gmail", "get"] else "gmail.messages.search")))
    return _run(command, exact, readonly=True)


def label_gmail(command, label):
    """The only mailbox write here: add or remove one named label on exact
    messages, or create that label. Sending stays blocked; nothing else runs."""
    if command[:3] == ["gmail", "labels", "create"] and command[3:] == [label]:
        return _run(command, "gmail.labels.create", readonly=False)
    flags = [part for part in command[3:] if part.startswith("--")]
    ids = [part for part in command[3:] if not part.startswith("--")]
    if command[:3] != ["gmail", "batch", "modify"] or flags not in ([f"--add={label}"], [f"--remove={label}"]) \
            or not ids or len(ids) > 50 or any(not re.fullmatch(r"[a-f0-9]{10,32}", mid) for mid in ids):
        raise ValueError("Only one named label on 1-50 exact message ids can be changed")
    return _run(command, "gmail.batch.modify", readonly=False)

"""Bounded native transport; a lost launch answer is never a replacement launch."""
import base64
import json
from pathlib import PureWindowsPath
import re
import subprocess

from .store import JobError, exact_id, exact_request

TARGET = re.compile(r"[A-Za-z0-9_.@:-]+\Z")


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def windows_command(host, verb, identifier=None, request_id=None, source_at=None):
    root = host["root"]
    worker = str(PureWindowsPath(root) / "host_job_worker.py")
    arguments = [host["python"], worker, "--root", str(PureWindowsPath(root) / "state"), verb]
    if identifier:
        arguments += ["--job", exact_id(identifier)]
    if request_id:
        arguments += ["--request", exact_request(request_id)]
    if source_at:
        from .schedule import instant
        arguments += ["--source-at", instant(source_at).isoformat()]
    script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); & " + " ".join(ps_quote(a) for a in arguments) + "; exit $LASTEXITCODE"
    return "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(script.encode("utf-16le")).decode()


def call(host, verb, identifier=None, request_id=None, timeout=20, source_at=None):
    target = host.get("sshTarget", "")
    if not TARGET.fullmatch(target) or target.startswith("-"):
        raise JobError("INVALID_HOST", "The executor host is invalid.", 503)
    command = windows_command(host, verb, identifier, request_id, source_at)
    args = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", target, command]
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout, text=True, encoding="utf-8")
    except (subprocess.TimeoutExpired, OSError):
        raise JobError("NATIVE_OUTCOME_UNKNOWN", "The native response is unavailable. Reconcile this request.", 503)
    if result.returncode == 255 and re.search(r"connect to host .*: (?:Connection refused|Connection timed out|No route to host)|Could not resolve hostname|Permission denied \(publickey|Host key verification failed", result.stderr, re.I):
        raise JobError("HOST_UNAVAILABLE", "The execution host is unavailable before dispatch.", 503)
    try:
        payload = json.loads(result.stdout.strip())
    except (ValueError, TypeError):
        if result.returncode == 255 and verb != "run":
            raise JobError("HOST_UNAVAILABLE", "The execution host is unavailable.", 503)
        raise JobError("NATIVE_OUTCOME_UNKNOWN", "The native result is incomplete. Reconcile this request.", 503)
    if payload.get("status") == "error":
        error = payload.get("error", {})
        raise JobError(error.get("code", "NATIVE_FAILURE"), error.get("message", "The native operation failed."), error.get("status", 409))
    if payload.get("contract") != "agentx.operations-worker/v1":
        raise JobError("NATIVE_OUTCOME_UNKNOWN", "The native result contract is unavailable.", 503)
    return payload["data"]

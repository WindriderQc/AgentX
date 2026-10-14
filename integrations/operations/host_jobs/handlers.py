"""Named operational handlers. Configuration contains paths, never shell commands."""
import json
import os
from pathlib import Path
import sys

from .store import JobError, load


def prepare(job, request_id, source_at=None):
    options = job.get("options", {})
    # Win32 OpenSSH exports its own descriptor table to the remote shell.
    # It no longer describes a handler's redirected handles; inheriting it into
    # another ssh/scp process can indefinitely block its standard streams.
    environment = {key: value for key, value in os.environ.items() if not key.endswith("_POSIX_FD_STATE")}
    environment["AGENTX_OPERATION_REQUEST_ID"] = request_id
    kind = job["kind"]
    cwd, receipt = None, None
    if kind == "codex-usage":
        command = [options["node"], options["script"], "--endpoint", options["endpoint"], "--lookback-days", str(options.get("lookbackDays", 7))]
    elif kind == "memory-review-submit":
        if options.get("environmentFile"):
            for line in Path(options["environmentFile"]).read_text(encoding="utf-8-sig").splitlines():
                key, separator, value = line.partition("=")
                if separator and key.strip() in {"SSL_CERT_FILE", "AGENTX_OPERATOR_TOKEN"}:
                    environment[key.strip()] = value.strip()
        cwd = options["productRoot"]
        command = [options["python"], "-m", "memory_review", "run", "--runtime", "claude-code", "--runtime", "codex",
                   "--mode", "shadow", "--submit-only", "--agentx-url", options["endpoint"], "--state-dir", options["stateRoot"]]
        for value in options.get("claudeProjects", []):
            command += ["--claude-project", value]
        for value in options.get("codexCwds", []):
            command += ["--codex-cwd", value]
    elif kind == "offhost-backup":
        command = [options["powershell"], "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options["script"],
                   "-SourceHost", options["sourceHost"], "-SourceRoot", options["sourceRoot"], "-DestinationRoot", options["destination"]]
        if source_at:
            command += ["-CompletedBefore", source_at]
        if options.get("applyRetention", False):
            command += ["-ApplyRetention"]
        receipt = Path(options["destination"]) / "latest-run.json"
    elif kind == "archive-mirror":
        command = [options["python"], options["script"], "--source-host", options["sourceHost"], "--source-root", options["sourceRoot"],
                   "--destination", options["destination"], "--latest-zfs-snapshot"]
        if options.get("remoteReceipt"):
            command += ["--remote-receipt", options["remoteReceipt"]]
        receipt = Path(options["destination"]) / "latest-run.json"
    elif kind == "bundle-delivery":
        command = [options["python"], options["script"], "--source-host", options["sourceHost"], "--source-root", options["sourceRoot"],
                   "--staging", options["staging"], "--destination", options["destination"]]
        receipt = Path(options["staging"]) / "delivery-receipt.json"
    else:
        raise JobError("UNSUPPORTED_HANDLER", "This operational handler is not supported.", 400)
    return command, cwd, environment, receipt


def metrics(job, receipt, stdout):
    value = load(receipt, {}) if receipt else {}
    result = {}
    if job["kind"] == "offhost-backup":
        result = {"files": value.get("files", 0), "bytes": sum(a.get("bytes", 0) for a in value.get("artifacts", [])),
                  "verified": value.get("hashesVerified", False)}
    elif job["kind"] == "archive-mirror":
        result = {"files": value.get("copied", 0), "bytes": value.get("bytesCopied", 0), "unchanged": value.get("unchanged", 0),
                  "verified": value.get("status") == "verified", "sourceFiles": value.get("sourceFiles", 0)}
    elif job["kind"] == "bundle-delivery":
        result = {key: value.get(key, 0) for key in ("files", "bytes", "unchanged")}
        result["verified"] = value.get("status") == "delivered"
    elif job["kind"] == "codex-usage":
        for candidate in [stdout, *reversed(stdout.splitlines())]:
            try:
                body = json.loads(candidate)
                if not isinstance(body, dict):
                    continue
                summary = body.get("summary", body)
                result = {key: summary[key] for key in ("sessions", "filesScanned", "accepted") if isinstance(summary.get(key), (int, bool))}
                if body.get("ok") is True and not body.get("dryRun"):
                    result["accepted"] = True
                break
            except (ValueError, TypeError):
                continue
    elif job["kind"] == "memory-review-submit":
        import re
        result["accepted"] = sum(int(n) for n in re.findall(r"accepted=(\d+)", stdout))
        result["noModelCall"] = True
    return result

"""Read-only Mint/APT qualification. This module has no installation action.

The native worker owns identity/replay; this adapter only resolves a proposed
security batch and writes its private receipt. A successful simulation is never
an installation receipt or proof that the installed system is fully patched.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .store import JobError, exact_request, load, now, save

POLICY_FIELDS = {"version", "revision", "mode", "allowedSources", "excludedSources",
                 "allowedOrigins", "maxPackages", "window", "maxIndexAgeHours"}
PACKAGE = re.compile(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?\Z")
VERSION = re.compile(r"[0-9][A-Za-z0-9.+:~\-]*\Z")


def policy_at(path):
    raw = Path(path).read_bytes()
    policy = json.loads(raw)
    if (not isinstance(policy, dict) or set(policy) != POLICY_FIELDS
            or type(policy.get("version")) is not int or policy.get("version") != 1 or policy.get("mode") != "simulate"
            or type(policy.get("revision")) is not int or policy["revision"] < 1):
        raise JobError("INVALID_PATCH_POLICY", "A versioned simulation policy is required.", 400)
    for key in ("allowedSources", "excludedSources", "allowedOrigins"):
        values = policy[key]
        if (not isinstance(values, list) or not values or len(values) > 100
                or any(not isinstance(v, str) or not v or len(v) > 100 for v in values)):
            raise JobError("INVALID_PATCH_POLICY", "The source and origin policy is invalid.", 400)
    for key, maximum in (("maxPackages", 1000), ("maxIndexAgeHours", 168)):
        if type(policy[key]) is not int or not 1 <= policy[key] <= maximum:
            raise JobError("INVALID_PATCH_POLICY", "The policy bound is invalid.", 400)
    window = policy["window"]
    if not isinstance(window, dict) or set(window) != {"timezone", "weekday", "start", "end"}:
        raise JobError("INVALID_PATCH_POLICY", "A bounded weekly window is required.", 400)
    try:
        ZoneInfo(window["timezone"])
        if type(window["weekday"]) is not int or not 0 <= window["weekday"] <= 6:
            raise ValueError()
        for key in ("start", "end"):
            if not re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", window[key]):
                raise ValueError()
        if window["start"] >= window["end"]:
            raise ValueError()
    except (KeyError, ValueError, TypeError):
        raise JobError("INVALID_PATCH_POLICY", "The weekly window is invalid.", 400)
    return policy, hashlib.sha256(raw).hexdigest()


def in_window(policy, at):
    window = policy["window"]
    local = at.astimezone(ZoneInfo(window["timezone"]))
    return local.weekday() == window["weekday"] and window["start"] <= local.strftime("%H:%M") < window["end"]


def source_allowed(policy, source):
    return (source in policy["allowedSources"]
            and not any(fnmatch.fnmatchcase(source, pattern) for pattern in policy["excludedSources"]))


def validate_changes(policy, changes):
    if len(changes) > policy["maxPackages"]:
        raise JobError("PATCH_BATCH_TOO_LARGE", "The resolved batch exceeds the policy bound.")
    for row in changes:
        if (not PACKAGE.fullmatch(row.get("package", "")) or not VERSION.fullmatch(row.get("candidate", ""))
                or row.get("action") != "upgrade" or row.get("held")
                or not source_allowed(policy, row.get("source", ""))
                or not row.get("origins") or not row.get("trusted")
                or any(origin not in policy["allowedOrigins"] for origin in row["origins"])):
            raise JobError("PATCH_PLAN_REFUSED", "A resolved dependency is outside the approved simulation policy.")


class NativeApt:
    """Installed Mint classifies security sources; APT resolves the complete batch."""
    def __init__(self):
        if os.geteuid() == 0:
            raise JobError("READ_ONLY_USER_REQUIRED", "Run the planner as an unprivileged user.")
        import apt
        import apt_pkg
        self.apt, self.apt_pkg = apt, apt_pkg

    def snapshot(self):
        # Include stamps AND content: an index replaced during resolution makes
        # this evidence unstable even when dpkg itself did not change.
        roots = [Path("/etc/apt"), Path("/var/lib/apt/lists")]
        paths = [Path("/var/lib/dpkg/status"), Path("/var/lib/apt/extended_states")]
        for root in roots:
            paths.extend(p for p in root.rglob("*") if p.is_file() and "partial" not in p.parts and p.name != "lock")
        digest = hashlib.sha256()
        for path in sorted(paths):
            try:
                digest.update(str(path).encode())
                digest.update(path.read_bytes())
            except FileNotFoundError:
                digest.update(b"missing")
        return digest.hexdigest()

    def audit(self):
        result = subprocess.run(["/usr/bin/dpkg", "--audit"], capture_output=True, text=True, timeout=30, env=self.environment())
        if result.returncode or result.stdout.strip() or result.stderr.strip():
            raise JobError("DPKG_AUDIT_FAILED", "The installed package database requires review.")

    @staticmethod
    def environment():
        # No caller-supplied APT_CONFIG, Python path or package-manager hooks.
        return {"PATH": "/usr/bin:/bin", "HOME": os.path.expanduser("~"), "LC_ALL": "C", "LANG": "C"}

    def candidates(self):
        # Do not trust the CLI's success message/exit status for an installation.
        # This fixed helper imports only the distribution's installed classifier;
        # it never requests a cache refresh or calls Mint's upgrade action.
        helper = '''import json, sys
sys.path.insert(0, "/usr/lib/linuxmint/mintUpdate")
from checkAPT import APTCheck
from Classes import PRIORITY_UPDATES
c = APTCheck(); c.find_changes()
print(json.dumps({"priority": c.priority_updates_available,
 "security": sorted({u.real_source_name for u in c.updates.values() if u.type == "security" and u.source_name not in PRIORITY_UPDATES})}))
'''
        result = subprocess.run(["/usr/bin/python3", "-I", "-c", helper], capture_output=True, text=True,
                                timeout=60, env=self.environment(), check=True)
        classification = json.loads(result.stdout)
        if classification["priority"]:
            raise JobError("MINT_PRIORITY_UPDATE", "Review the update tool before qualifying another batch.")
        self.cache = self.apt.Cache()
        self.cache.clear()
        security = set(classification["security"])
        rows = []
        for pkg in self.cache:
            if pkg.is_upgradable:
                row = self.row(pkg)
                row["security"] = row["source"] in security
                rows.append(row)
        return rows

    def row(self, pkg):
        version = pkg.candidate
        origins = [o for o in version.origins if o.origin]
        action = ("remove" if pkg.marked_delete else "install" if not pkg.is_installed else
                  "downgrade" if self.apt_pkg.version_compare(version.version, pkg.installed.version) < 0 else "upgrade")
        return {"package": pkg.fullname, "installed": pkg.installed.version if pkg.installed else None,
                "candidate": version.version, "source": version.source_name, "action": action,
                "held": pkg._pkg.selected_state == self.apt_pkg.SELSTATE_HOLD,
                "origins": sorted({o.origin for o in origins}), "trusted": bool(origins) and all(o.trusted for o in origins)}

    def resolve(self, selected):
        for row in selected:
            pkg = self.cache[row["package"]]
            if pkg.candidate.version != row["candidate"]:
                raise JobError("PATCH_INPUT_CHANGED", "A candidate changed during qualification.")
            pkg.mark_install(auto_fix=True, auto_inst=True, from_user=True)
        if self.cache.broken_count:
            raise JobError("PATCH_DEPENDENCIES_BROKEN", "The resolved batch has broken dependencies.")
        return sorted((self.row(pkg) for pkg in self.cache.get_changes()), key=lambda row: row["package"])

    def simulate(self, changes):
        if not changes:
            return 0
        # Every token comes from a validated native package/version. Always -s;
        # there is deliberately no option to remove it, even in configuration.
        command = ["/usr/bin/apt-get", "--simulate", "--no-remove", "--only-upgrade", "--no-install-recommends",
                   "-o", "Debug::NoLocking=1", "install"] + [r["package"] + "=" + r["candidate"] for r in changes]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120, env=self.environment())
        # Logs are private on the worker. The real APT status is authoritative.
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode

    def index_age(self, at):
        stamp = Path("/var/lib/apt/periodic/update-success-stamp")
        try:
            age = int(at.timestamp() - stamp.stat().st_mtime)
            return age if age >= 0 else None
        except FileNotFoundError:
            return None


def qualify(policy_path, receipt_path, request_id, backend=None, at=None, enforce_window=False):
    exact_request(request_id)
    receipt_path = Path(receipt_path)
    policy, digest = policy_at(policy_path)
    existing = load(receipt_path)
    if existing:
        if (existing.get("requestId") != request_id or existing.get("policyHash") != digest
                or existing.get("windowEnforced") != enforce_window):
            raise JobError("REQUEST_CONFLICT", "The simulation receipt belongs to another intent.")
        return existing
    backend = backend or NativeApt()
    at = at or datetime.now(timezone.utc)
    receipt = {"contract": "agentx.apt-plan/v1", "requestId": request_id, "policyRevision": policy["revision"],
               "policyHash": digest, "state": "running", "createdAt": now(), "mode": "simulate",
               "installationPerformed": False, "withinWindow": in_window(policy, at), "windowEnforced": enforce_window}
    save(receipt_path, receipt)
    try:
        if enforce_window and not receipt["withinWindow"]:
            raise JobError("PATCH_WINDOW_MISSED", "The real execution time is outside the policy window.")
        before = backend.snapshot()
        backend.audit()
        candidates = backend.candidates()
        selected = [r for r in candidates if r.get("security") and source_allowed(policy, r["source"])]
        # Holds/origins/dependency additions are checked, not silently skipped.
        validate_changes(policy, selected)
        changes = backend.resolve(selected) if selected else []
        validate_changes(policy, changes)
        code = backend.simulate(changes) if changes else None
        receipt.update(aptExitCode=code, aptInvoked=bool(changes), candidates=candidates, selected=changes)
        if code:
            raise JobError("APT_SIMULATION_FAILED", "APT refused the proposed batch.")
        if enforce_window and not in_window(policy, datetime.now(timezone.utc)):
            raise JobError("PATCH_WINDOW_MISSED", "Qualification ended outside the policy window.")
        backend.audit()
        if backend.snapshot() != before or policy_at(policy_path)[1] != digest:
            raise JobError("PATCH_INPUT_CHANGED", "Package, index or policy inputs changed during qualification.")
        age = backend.index_age(at)
        receipt.update(state="completed", finishedAt=now(), indexMarkerAgeSeconds=age,
                       indexEvidence="unknown" if age is None else "native-success-marker",
                       metrics={"simulationOnly": True, "pendingPackages": len(candidates), "selectedPackages": len(changes),
                                "excludedPackages": len(candidates) - len(selected), "verified": True,
                                "withinWindow": receipt["withinWindow"],
                                "indexesFresh": age is not None and age <= policy["maxIndexAgeHours"] * 3600})
    except Exception as error:
        receipt.update(state="failed", code=getattr(error, "code", "APT_PLAN_UNAVAILABLE"), finishedAt=now())
        save(receipt_path, receipt)
        raise
    save(receipt_path, receipt)
    return receipt

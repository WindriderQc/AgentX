#!/usr/bin/env python3
"""Import an Outlook mailbox export (PST) into the private Secretary evidence archive.

The PST itself is kept unchanged, by hash, as the export's original. Its items
are extracted with readpst (pst-utils): mail as .eml, contacts as .vcf and
calendar entries as .ics, each stored once by content hash with the folders it
appeared in. These files are readpst's conversion of the PST, not bytes from
Microsoft's servers; a later Graph connector can add server originals. Mail is
linked to the archived Gmail copy of the same Message-ID. Reports hold counts
and identifiers only.
"""
from __future__ import annotations

import argparse
import email
from email import policy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from raw_messages import archived_messages, folded  # noqa: E402
from secretary_evidence import DEFAULT_ROOT, Archive, load, now, save  # noqa: E402


KINDS = {".eml": "mail", ".vcf": "contact", ".ics": "calendar"}
PROVIDER = "outlook"


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def private_copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staged = target.with_name(target.name + ".tmp")
    shutil.copyfile(source, staged)
    staged.chmod(0o600)
    staged.replace(target)


def extract(pst, directory, readpst="readpst", run=subprocess.run):
    """readpst writes one file per item under folder directories."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = run([readpst, "-e", "-q", "-j", "4", "-o", str(directory), str(pst)], capture_output=True)
    if result.returncode:
        raise RuntimeError(f"readpst failed (exit {result.returncode})")


def import_pst(root, pst, readpst="readpst", run=subprocess.run):
    root, pst = Path(root), Path(pst)
    base = root / PROVIDER
    export_sha = sha_file(pst)
    original = base / "exports" / f"{export_sha}.pst"
    if not (original.is_file() and original.stat().st_size == pst.stat().st_size and sha_file(original) == export_sha):
        private_copy(pst, original)
    inventory = load(base / "inventory.json", {"items": {}})
    gmail = {}
    for row in archived_messages(Archive(root, run=lambda _: {})):
        if row["messageIdHeader"]:
            gmail.setdefault(row["messageIdHeader"], []).append(row["id"])
    staging = base / f"staging-{export_sha[:12]}"
    shutil.rmtree(staging, ignore_errors=True)
    report = {"export": export_sha, "exportBytes": pst.stat().st_size, "startedAt": now(), "extracted": 0,
              "stored": 0, "alreadyArchived": 0, "duplicatesInExport": 0, "byKind": {}, "other": 0,
              "mailWithoutMessageId": 0, "mailAlsoInGmail": 0}
    seen = set()
    try:
        extract(original, staging, readpst, run)
        for file in sorted(p for p in staging.rglob("*") if p.is_file()):
            kind = KINDS.get(file.suffix.lower())
            report["extracted"] += 1
            if not kind:
                report["other"] += 1
                continue
            digest = sha_file(file)
            folder = file.parent.relative_to(staging).as_posix()
            first = digest not in seen
            seen.add(digest)
            if first:
                report["byKind"][kind] = report["byKind"].get(kind, 0) + 1
            else:
                report["duplicatesInExport"] += 1
            item = inventory["items"].get(digest)
            if item is None:
                relative = Path(PROVIDER) / "items" / digest[:2] / f"{digest}{file.suffix.lower()}"
                private_copy(file, root / relative)
                item = {"sha256": digest, "kind": kind, "bytes": file.stat().st_size,
                        "path": relative.as_posix(), "folders": [], "exports": [], "firstImportedAt": now()}
                if kind == "mail":
                    with open(file, "rb") as handle:
                        parsed = email.message_from_binary_file(handle, policy=policy.compat32)
                    item["messageId"] = folded(parsed.get("Message-ID") or "")
                    item["date"] = folded(parsed.get("Date") or "")
                inventory["items"][digest] = item
                report["stored"] += 1
            elif first:
                report["alreadyArchived"] += 1
            if folder not in item["folders"]:
                item["folders"].append(folder)
            if export_sha not in item["exports"]:
                item["exports"].append(export_sha)
            if kind == "mail" and first:
                item["alsoInGmail"] = gmail.get(item.get("messageId") or "", [])
                report["mailWithoutMessageId"] += not item.get("messageId")
                report["mailAlsoInGmail"] += bool(item["alsoInGmail"])
        save(base / "inventory.json", inventory)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    report.update(completedAt=now(), inventoryItems=len(inventory["items"]),
                  status="imported" if report["extracted"] else "empty")
    exports = load(base / "exports.json", {})
    exports[export_sha] = {k: report[k] for k in ("exportBytes", "completedAt", "extracted", "stored", "byKind")}
    save(base / "exports.json", exports)
    save(base / f"import-{export_sha[:12]}.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--readpst", default=os.environ.get("SECRETARY_READPST", "readpst"))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("import", help="Import one PST export").add_argument("pst", type=Path)
    sub.add_parser("status")
    args = parser.parse_args()
    if args.command == "status":
        base = args.root / PROVIDER
        items = load(base / "inventory.json", {"items": {}})["items"].values()
        kinds = {}
        for item in items:
            kinds[item["kind"]] = kinds.get(item["kind"], 0) + 1
        print(json.dumps({"exports": len(load(base / "exports.json", {})), "items": kinds,
                          "mailAlsoInGmail": sum(bool(i.get("alsoInGmail")) for i in items)}))
        return 0
    if not args.pst.is_file():
        parser.error("PST file not found")
    print(json.dumps(import_pst(args.root, args.pst, args.readpst)))
    return 0


if __name__ == "__main__":
    sys.exit(main())

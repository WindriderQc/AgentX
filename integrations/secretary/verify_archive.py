#!/usr/bin/env python3
"""Verify a copy of the private Secretary evidence archive, as a restore drill.

Point it at any copy of the archive (the live root, an off-host mirror's
`current` directory, or a restored tree). It never contacts a provider and
never writes inside the copy. It re-reads every recorded file against its
SHA-256: original .eml messages (and their Message-ID against the archived
thread), attachments, Outlook export items and the kept PST exports. With
--sample it also restores some originals into a disposable directory and opens
them the way a mail client does (full MIME walk, every part decoded).
The report holds counts, identifiers and relative paths only.
"""
from __future__ import annotations

import argparse
import email
from email import policy
import hashlib
import json
from pathlib import Path
import random
import re
import shutil
import socket
import sys
import tempfile
import time


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load(file, default=None):
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def folded(value):
    return " ".join(str(value).split())


class Tally:
    def __init__(self):
        self.ok, self.missing, self.mismatched = 0, [], []
        self.sources = {}

    def check(self, root, relative, sha256, size=None, key=None):
        file = (root / relative).resolve()
        if not file.is_relative_to(root.resolve()):
            self.mismatched.append(key or relative)
            return False
        if not file.is_file():
            self.missing.append(key or relative)
            return False
        if (size is not None and file.stat().st_size != size) or sha_file(file) != sha256:
            self.mismatched.append(key or relative)
            return False
        self.ok += 1
        self.sources[str(key or relative)] = {"path": relative, "sha256": sha256,
                                               "bytes": file.stat().st_size}
        return True

    def report(self):
        return {"verified": self.ok, "missing": len(self.missing), "mismatched": len(self.mismatched),
                "missingIds": self.missing[:200], "mismatchedIds": self.mismatched[:200]}


def verify_tree(root, index, with_sources=False):
    """Rehash every indexed file, including metadata skipped by incremental sync.

    Accept the native mirror-state file as the expected snapshot file index.
    This does not change that mirror, trust size/mtime shortcuts or enumerate a
    live .zfs subtree. The same pinned index can be checked on both hosts.
    """
    tally = Tally()
    files = index.get("files", {})
    if not isinstance(files, dict) or not files:
        tally.mismatched.append("invalid_or_empty_tree_index")
        files = {}
    for relative, meta in files.items():
        if not isinstance(relative, str) or not relative or not isinstance(meta, dict) \
                or not isinstance(meta.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", meta["sha256"]) \
                or type(meta.get("bytes")) is not int or meta["bytes"] < 0:
            tally.mismatched.append(relative)
            continue
        tally.check(root, relative, meta["sha256"], meta["bytes"])
    return {**tally.report(), "expectedFiles": len(files),
            "indexSha256": hashlib.sha256(json.dumps(index, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
            **({"verifiedFiles": tally.sources} if with_sources else {})}


def verify(root, with_sources=False, tree_index=None):
    root = Path(root)
    manifests = {}
    for file in (root / "threads").glob("*/manifest.json"):
        manifest = load(file)
        if manifest:
            manifests[manifest["threadId"]] = manifest
    threads = {"manifests": len(manifests),
               "withoutOriginal": sum(not (root / "threads" / t / "original.json").is_file() for t in manifests)}

    headers = {m["id"]: folded((m.get("headers") or {}).get("message-id", ""))
               for manifest in manifests.values() for m in manifest["messages"]}
    raw, raw_ids = Tally(), []
    for file in sorted((root / "raw-receipts").glob("*.json")):
        receipt = load(file)
        if not receipt:
            raw.mismatched.append(file.stem)
            continue
        if raw.check(root, receipt["path"], receipt["sha256"], receipt["bytes"], receipt["messageId"]):
            expected = headers.get(receipt["messageId"])
            if expected:
                with open(root / receipt["path"], "rb") as handle:
                    found = folded(email.message_from_binary_file(handle, policy=policy.compat32).get("Message-ID") or "")
                if found != expected:
                    raw.ok -= 1
                    raw.sources.pop(receipt["messageId"], None)
                    raw.mismatched.append(receipt["messageId"])
                    continue
            raw_ids.append(receipt)
    archived = set(headers)
    raw_report = {**raw.report(), "archivedMessages": len(archived),
                  "withoutOriginal": len(archived - {r["messageId"] for r in raw_ids})}

    attachments = Tally()
    for manifest in manifests.values():
        for message in manifest["messages"]:
            for item in message.get("attachments", []):
                if item.get("path") and item.get("sha256"):
                    attachments.check(root, item["path"], item["sha256"], item.get("bytes"), item["path"])
                else:
                    attachments.missing.append(f"{message['id']}:{item.get('partId', 'unknown')}")

    outlook, exports = Tally(), Tally()
    for item in (load(root / "outlook" / "inventory.json", {"items": {}})["items"]).values():
        outlook.check(root, item["path"], item["sha256"], item.get("bytes"), item["path"])
    for sha256, export in load(root / "outlook" / "exports.json", {}).items():
        exports.check(root, f"outlook/exports/{sha256}.pst", sha256, export.get("exportBytes"), sha256)

    report = {"at": now(), "threads": threads, "raw": raw_report, "attachments": attachments.report(),
              "outlookItems": outlook.report(), "outlookExports": exports.report()}
    problems = (threads["withoutOriginal"] + raw_report["withoutOriginal"]
                + sum(report[k]["missing"] + report[k]["mismatched"]
                for k in ("raw", "attachments", "outlookItems", "outlookExports")))
    if tree_index is not None:
        report["archiveTree"] = verify_tree(root, tree_index, with_sources)
        problems += report["archiveTree"]["missing"] + report["archiveTree"]["mismatched"]
    report["intact"] = problems == 0
    tree_files = report.get("archiveTree", {}).pop("verifiedFiles", None)
    if with_sources:
        report["verificationProof"] = {
            "schema": "agentx.secretary-archive-verification/v1", "at": report["at"],
            "host": socket.gethostname(), "root": str(root.resolve()), "intact": report["intact"],
            "threads": {tid: {"evidenceHash": m["evidenceHash"]} for tid, m in manifests.items()},
            "raw": raw.sources, "attachments": attachments.sources,
            "outlookItems": outlook.sources, "outlookExports": exports.sources,
            **({"archiveTree": report["archiveTree"]} if tree_index is not None else {}),
            **({"archiveTreeFiles": tree_files} if tree_files is not None else {}),
        }
    return report, raw_ids


def restore_sample(root, receipts, count, target=None, seed=None):
    """Copy some originals out and open each like a mail client would."""
    chosen = random.Random(seed).sample(receipts, min(count, len(receipts)))
    work = Path(target) if target else Path(tempfile.mkdtemp(prefix="archive-restore-"))
    work.mkdir(parents=True, exist_ok=True)
    opened = parts = attachments = 0
    failures = []
    try:
        for receipt in chosen:
            restored = work / Path(receipt["path"]).name
            shutil.copyfile(Path(root) / receipt["path"], restored)
            try:
                if sha_file(restored) != receipt["sha256"]:
                    raise ValueError("restored copy differs")
                with open(restored, "rb") as handle:
                    message = email.message_from_binary_file(handle, policy=policy.default)
                for part in message.walk():
                    if part.is_multipart():
                        continue
                    part.get_content()  # decodes the transfer encoding and charset
                    parts += 1
                    attachments += part.get_filename() is not None
                opened += 1
            except Exception as error:  # report and continue: one bad message is a finding
                failures.append({"messageId": receipt["messageId"], "error": type(error).__name__})
    finally:
        if not target:
            shutil.rmtree(work, ignore_errors=True)
    return {"sampled": len(chosen), "opened": opened, "partsDecoded": parts,
            "attachmentsDecoded": attachments, "failures": failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Root of the archive copy to verify")
    parser.add_argument("--sample", type=int, default=0, help="Restore and open this many originals")
    parser.add_argument("--restore-to", type=Path, help="Keep the restored sample here instead of a temporary directory")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--report", type=Path, help="Write the JSON report here (outside the copy)")
    parser.add_argument("--proof", type=Path, help="Write per-source hash verification evidence outside the copy")
    parser.add_argument("--tree-index", type=Path, help="Pinned native mirror-state file; rehash every indexed file, metadata included")
    args = parser.parse_args()
    for output in (args.proof, args.report, args.restore_to):
        if output and output.resolve().is_relative_to(args.root.resolve()):
            parser.error("Verification reports and proofs must stay outside the archive copy")
    tree = load(args.tree_index) if args.tree_index else None
    if args.tree_index and not isinstance(tree, dict):
        parser.error("The expected tree index is absent or invalid")
    report, receipts = verify(args.root, with_sources=bool(args.proof), tree_index=tree)
    if args.sample:
        report["restoreSample"] = restore_sample(args.root, receipts, args.sample, args.restore_to, args.seed)
        report["intact"] = report["intact"] and not report["restoreSample"]["failures"]
    proof = report.pop("verificationProof", None)
    if args.proof:
        from evidence_store import save
        proof.update(intact=report["intact"], restoreSample=report.get("restoreSample"))
        save(args.proof, proof)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if report["intact"] else 2


if __name__ == "__main__":
    sys.exit(main())

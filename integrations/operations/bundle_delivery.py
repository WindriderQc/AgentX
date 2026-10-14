#!/usr/bin/env python3
"""Verified, non-destructive delivery of a published bundle into a local workspace."""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

import archive_mirror


def deliver(source_host, source_root, staging, destination):
    staging, destination = Path(staging), Path(destination)
    # The existing mirror retains replaced originals and rejects unsafe tar paths.
    remote = archive_mirror.Remote(source_host, source_root)
    result = archive_mirror.mirror(remote, staging)
    if result.get("status") != "verified":
        raise RuntimeError("The published source was not verified")
    current = staging / "current"
    archive_mirror.private_directory(destination)
    copied, unchanged, byte_count = 0, 0, 0
    for source in sorted(current.rglob("*")):
        if not source.is_file() or source.is_symlink():
            continue
        relative = source.relative_to(current)
        target = destination / relative
        parent = target.parent
        parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() or any(p.is_symlink() for p in [parent, *parent.parents] if p != destination.parent):
            raise RuntimeError("The destination contains an unsafe link")
        expected = archive_mirror.sha256_file(source)
        if target.exists() and archive_mirror.sha256_file(target) == expected:
            unchanged += 1
            continue
        temporary = target.with_name(target.name + "." + str(uuid.uuid4()) + ".partial")
        try:
            shutil.copyfile(source, temporary)
            if archive_mirror.sha256_file(temporary) != expected:
                raise RuntimeError("The delivered file hash differs")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        copied += 1
        byte_count += source.stat().st_size
    receipt = {"status": "delivered", "completedAt": archive_mirror.now(), "files": copied, "unchanged": unchanged,
               "bytes": byte_count, "requestId": os.environ.get("AGENTX_OPERATION_REQUEST_ID")}
    archive_mirror.save(staging / "delivery-receipt.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-host", required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(deliver(args.source_host, args.source_root, args.staging, args.destination)))
        return 0
    except Exception:
        print(json.dumps({"status": "failed", "code": "DELIVERY_FAILED"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())

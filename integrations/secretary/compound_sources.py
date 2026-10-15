"""Preserve bounded compound attachment members and expose their separate reading scope.

Indexing is explicit operator work, never part of collecting or opening a mail.
Original MIME, attachments, page identities and reading receipts stay unchanged.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import time

from compound_archive import CompoundError, members
from evidence_store import load, now, save

CONTRACT = "agentx.secretary-compound-sources/v1"
HASH = re.compile(r"[a-f0-9]{64}")
SUFFIXES = (".zip", ".rar", ".7z", ".tar", ".tgz", ".gz", ".bz2", ".xz",
            ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".eml", ".msg")
MIMES = {"application/zip", "application/x-zip-compressed", "application/vnd.rar",
         "application/x-rar-compressed", "application/x-7z-compressed", "application/x-tar",
         "application/gzip", "message/rfc822", "application/vnd.ms-outlook"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(parent, ordinal, name):
    return digest(json.dumps([parent, ordinal, name], ensure_ascii=False).encode())


def container_kind(name="", head=b"", mime=""):
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
        return "zip"
    if head.startswith((b"Rar!\x1a\x07", b"7z\xbc\xaf\x27\x1c", b"\x1f\x8b", b"BZh", b"\xfd7zXZ\x00")) \
            or head[257:262] == b"ustar":
        return "archive"
    return "declared" if name.lower().endswith(SUFFIXES) or mime.lower() in MIMES else None


@dataclass(frozen=True)
class Limits:
    input_bytes: int = 32 * 1024 * 1024
    member_bytes: int = 8 * 1024 * 1024
    total_bytes: int = 64 * 1024 * 1024
    entries: int = 256
    depth: int = 3
    seconds: float = 30


def confined(root, relative):
    if not isinstance(relative, str):
        raise CompoundError("source_path_missing")
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise CompoundError("source_path_outside_archive")
    return path


def index_path(root, sha):
    if not HASH.fullmatch(sha or ""):
        raise CompoundError("source_hash_invalid")
    return confined(Path(root), "compound-sources/indexes/" + sha + ".json")


def _source(root, item, maximum):
    path = confined(root, item.get("path"))
    if not path.is_file() or path.stat().st_size != item.get("bytes"):
        raise CompoundError("source_bytes_unavailable")
    if path.stat().st_size > maximum:
        raise CompoundError("source_size_limit")
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum or len(data) != item.get("bytes") or digest(data) != item.get("sha256"):
        raise CompoundError("source_integrity_failed")
    return data


def is_compound(root, item):
    kind = container_kind(item.get("filename", ""), mime=item.get("mimeType") or "")
    if kind:
        return True
    try:
        with confined(Path(root), item.get("path")).open("rb") as stream:
            return bool(container_kind(head=stream.read(512)))
    except (OSError, ValueError):
        return False  # Original/attachment preservation guards independently refuse missing bytes.


def index_attachment(root, item, *, limits=None, retry=False, reader=members):
    root, limits = Path(root).resolve(), limits or Limits()
    output = index_path(root, item.get("sha256"))
    if output.exists() and not retry:
        return scope(root, item)
    result = {"schema": CONTRACT, "at": now(), "sourceSha256": item["sha256"],
              "sourceBytes": item.get("bytes"), "status": "incomplete", "members": [],
              "errors": [], "dataAndNamesAreUntrusted": True, "analysisAccepted": False}
    deadline, expanded = time.monotonic() + limits.seconds, 0

    def walk(data, kind, parent, depth):
        nonlocal expanded
        if depth > limits.depth:
            raise CompoundError("nesting_depth_limit")
        iterator = iter(reader(data, kind))
        try:
            for ordinal, entry in enumerate(iterator):
                if time.monotonic() > deadline:
                    raise CompoundError("inventory_deadline")
                if len(result["members"]) >= limits.entries:
                    raise CompoundError("entry_count_limit")
                name, size = entry["name"], entry["bytes"]
                normalized = name.replace("\\", "/")
                if not name or len(name) > 2048 or "\x00" in name or ":" in normalized \
                        or normalized.startswith("/") or ".." in PurePosixPath(normalized).parts:
                    raise CompoundError("unsafe_member_name")
                member = {"id": identity(parent, ordinal, name), "parentId": parent,
                          "ordinal": ordinal, "nameAsWritten": name, "kind": entry["kind"],
                          "bytes": size, "readingState": "unread", "role": entry.get("role", "member"),
                          "metadata": entry.get("metadata", {})}
                result["members"].append(member)
                if entry["kind"] == "directory":
                    continue
                if entry["kind"] != "file":
                    raise CompoundError("special_member_not_read")
                if entry.get("encrypted"):
                    raise CompoundError("encrypted_member")
                if type(size) is not int or not 0 <= size <= limits.member_bytes:
                    raise CompoundError("member_size_limit")
                if expanded + size > limits.total_bytes:
                    raise CompoundError("expanded_size_limit")
                content = entry["read"](limits.member_bytes)
                if len(content) != size:
                    raise CompoundError("member_size_mismatch")
                expanded += len(content)
                sha = digest(content)
                relative = f"compound-sources/blobs/{sha}.bin"
                blob = confined(root, relative)
                blob.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if blob.exists():
                    if blob.read_bytes() != content:
                        raise CompoundError("preserved_member_integrity_failed")
                else:
                    with blob.open("xb") as stream:
                        stream.write(content)
                    blob.chmod(0o600)
                member.update(sha256=sha, path=relative)
                nested = container_kind(name, content[:512])
                if nested:
                    member["container"] = nested
                    walk(content, nested, member["id"], depth + 1)
        finally:
            close = getattr(iterator, "close", None)
            if close:
                close()

    try:
        data = _source(root, item, limits.input_bytes)
        kind = container_kind(item.get("filename", ""), data[:512], item.get("mimeType") or "")
        if not kind:
            raise CompoundError("not_a_compound_attachment")
        if kind == "declared":
            raise CompoundError("unsupported_or_invalid_container")
        result["metadataScope"] = {"timestampsAreNotLifeEvents": True,
                                   "unexposedFormatHeadersOrCommentsNeedSeparateReview": kind != "zip"}
        walk(data, kind, item["sha256"], 0)
        if _source(root, item, limits.input_bytes) != data:
            raise CompoundError("source_changed_during_inventory")
        result["status"] = "complete"
    except Exception as error:
        result["errors"].append(str(error)[:300] if isinstance(error, CompoundError)
                                else "archive_decode_failed:" + type(error).__name__)
    result["expandedBytes"] = expanded
    if output.exists():
        prior = output.read_bytes()
        old = root / "compound-sources" / "history" / item["sha256"] / (digest(prior) + ".json")
        if not old.exists():
            old.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with old.open("xb") as stream:
                stream.write(prior)
            old.chmod(0o600)
    save(output, result)
    return scope(root, item)


def scope(root, item, *, verify_members=True):
    """Read cached coverage only. Never decompress while opening/planning mail."""
    root = Path(root).resolve()
    index = index_path(root, item.get("sha256"))
    fallback = {"schema": CONTRACT, "sourceSha256": item.get("sha256"), "status": "missing", "members": []}
    try:
        if not index.is_file():
            return fallback
        confined(root, item.get("path"))
        if verify_members:
            _source(root, item, Limits().input_bytes)
        if index.stat().st_size > 2 * 1024 * 1024:
            raise CompoundError("inventory_size_limit")
        data = index.read_bytes(); result = json.loads(data.decode("utf-8"))
        if not isinstance(result, dict) or result.get("schema") != CONTRACT or result.get("sourceSha256") != item.get("sha256") \
                or result.get("sourceBytes") != item.get("bytes") or not isinstance(result.get("members"), list) \
                or len(result["members"]) > 256 or result.get("status") not in ("complete", "incomplete"):
            raise CompoundError("inventory_invalid")
        seen, expanded = {item["sha256"]}, 0
        for entry in result["members"]:
            if entry["parentId"] not in seen or entry["id"] in seen \
                    or entry["id"] != identity(entry["parentId"], entry["ordinal"], entry["nameAsWritten"]):
                raise CompoundError("inventory_member_identity_invalid")
            seen.add(entry["id"])
            if entry["kind"] not in ("file", "directory") and result["status"] == "complete":
                raise CompoundError("special_member_not_read")
            if entry["kind"] == "file" and (result["status"] == "complete" or entry.get("path") or entry.get("sha256")):
                sha = entry.get("sha256", "")
                if type(entry.get("bytes")) is not int or not 0 <= entry["bytes"] <= Limits().member_bytes \
                        or not HASH.fullmatch(sha) or entry.get("path") != f"compound-sources/blobs/{sha}.bin":
                    raise CompoundError("inventory_member_path_invalid")
                expanded += entry["bytes"]
                if expanded > Limits().total_bytes:
                    raise CompoundError("expanded_size_limit")
                file = confined(root, entry["path"])
                if not file.is_file() or file.stat().st_size != entry["bytes"] \
                        or verify_members and digest(file.read_bytes()) != sha:
                    raise CompoundError("preserved_member_integrity_failed")
        return {**result, "indexPath": index.relative_to(root).as_posix(), "indexSha256": digest(data),
                "readingState": "unread", "analysisAccepted": False, "memberCopiesChecked": verify_members}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {**fallback, "status": "invalid", "errors": [str(error) if isinstance(error, CompoundError)
                                                                 else "inventory_invalid"]}


def packet_scopes(root, attachments, *, verify_members=True):
    results, entries, expanded, index_bytes = {}, 0, 0, 0
    for item in attachments:
        sha = item.get("sha256")
        if not sha or not is_compound(root, item):
            continue
        cached = scope(root, item, verify_members=False)
        entries += len(cached["members"])
        expanded += sum(max(0, m.get("bytes", 0)) for m in cached["members"] if type(m.get("bytes")) is int)
        path = index_path(root, sha)
        index_bytes += path.stat().st_size if path.is_file() else 0
        if entries > Limits().entries or expanded > Limits().total_bytes or index_bytes > 2 * 1024 * 1024:
            cached = {"schema": CONTRACT, "sourceSha256": sha, "status": "packet_scope_limit", "members": []}
        elif verify_members:
            cached = scope(root, item)
        results[sha] = cached
    return results


def proof_paths(scopes):
    paths = {path for value in scopes.values() for path in
                   ([value["indexPath"]] if value.get("indexPath") else [])
                   + [m["path"] for m in value.get("members", []) if m.get("path")]}
    return sorted(p for p in paths if re.fullmatch(r"compound-sources/(?:indexes/[a-f0-9]{64}\.json|blobs/[a-f0-9]{64}\.bin)", p))


def decision_reasons(scopes, decisions, metadata=None):
    reasons, expected = [], set()
    metadata = metadata if isinstance(metadata, dict) else {}
    if not isinstance(decisions, dict):
        return ["compound_member_dispositions_incomplete"]
    if set(metadata) != set(scopes):
        reasons.append("compound_metadata_dispositions_incomplete")
    for key in scopes:
        item = metadata.get(key, {})
        if not isinstance(item, dict) or item.get("state") not in ("addressed", "no_relevant_content") \
                or not str(item.get("reason", "")).strip() or not str(item.get("evidenceRef", "")).strip():
            reasons.append("compound_metadata_disposition_unproven")
    for value in scopes.values():
        if value["status"] != "complete" or value.get("errors"):
            reasons.append("compound_inventory_missing_or_incomplete")
        expected.update(m["id"] for m in value.get("members", []) if m["kind"] == "file")
    if set(decisions) != expected:
        reasons.append("compound_member_dispositions_incomplete")
    for key in expected:
        item = decisions.get(key, {})
        if not isinstance(item, dict) or item.get("state") not in ("addressed", "no_relevant_content") \
                or not str(item.get("reason", "")).strip() or not str(item.get("evidenceRef", "")).strip():
            reasons.append("compound_member_disposition_unproven")
    return reasons


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--message-id", required=True)
    parser.add_argument("--retry", action="store_true", help="Explicitly reindex, retaining the exact prior index")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,256}", args.message_id):
        parser.error("Invalid message identity")
    receipt = load(args.root / "raw-receipts" / (args.message_id + ".json"), {})
    thread = receipt.get("threadId", "")
    if not re.fullmatch(r"[a-zA-Z0-9_-]{8,256}", thread):
        parser.error("Archived message receipt is unavailable")
    manifest = load(args.root / "threads" / thread / "manifest.json", {})
    message = next((m for m in manifest.get("messages", []) if m.get("id") == args.message_id), {})
    results = [index_attachment(args.root, item, retry=args.retry) for item in message.get("attachments", [])
               if item.get("sha256") and is_compound(args.root, item)]
    print(json.dumps({"messageId": args.message_id, "indexed": len(results),
                      "completeInventories": sum(x["status"] == "complete" for x in results),
                      "unreadMembers": sum(len(x["members"]) for x in results),
                      "analysisAccepted": False, "mailboxEffects": 0}))


if __name__ == "__main__":
    main()

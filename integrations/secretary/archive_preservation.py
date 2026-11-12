"""Verify one pinned native archive source, without writing or calling mail.

The scope is the original bytes, their recorded attachment copies and strict
in-memory MIME decoding. It is not a disk restore, corpus acceptance or consent.
"""
from __future__ import annotations

from collections import Counter
import base64
import binascii
import email
from email import policy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import quopri

from archive_read import CHARSET_ALIASES

CONTRACT = "secretary.archive-preservation/v1"
MAX_BYTES = 16 * 1024 * 1024
MAX_ATTACHMENTS = 128
MAX_PARTS = 4096
MACHINE_ID_FILE = Path("/etc/machine-id")
HASH = re.compile(r"[a-f0-9]{64}")
MAIL_ID = re.compile(r"[a-f0-9]{10,32}")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")


class PreservationError(RuntimeError):
    def __init__(self, code="SECRETARY_PRESERVATION_INTEGRITY", status=409):
        super().__init__("The selected native archive preservation scope could not be verified")
        self.code, self.status = code, status


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stamp(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PreservationError()
        result[key] = value
    return result


class SourceFiles:
    """No-follow reads below one open native root, with one shared byte budget."""
    def __init__(self, root):
        self.root = Path(root).resolve(strict=True)
        self.fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.root_stamp = stamp(os.fstat(self.fd))
        self.files, self.remaining = {}, MAX_BYTES

    def close(self):
        for fd, _, _ in self.files.values():
            os.close(fd)
        os.close(self.fd)

    def open(self, relative):
        if not isinstance(relative, str) or not relative or len(relative) > 4096 \
                or "\\" in relative or any(part in ("", ".", "..") for part in relative.split("/")):
            raise PreservationError()
        directory = os.dup(self.fd)
        try:
            parts = relative.split("/")
            for part in parts[:-1]:
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory); directory = next_fd
            return os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        finally:
            os.close(directory)

    def read(self, relative):
        if relative in self.files:
            return self.files[relative][2]
        fd = self.open(relative)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise PreservationError()
            if before.st_size > self.remaining:
                raise PreservationError("SECRETARY_PRESERVATION_TOO_LARGE", 413)
            chunks, left = [], before.st_size
            while left:
                chunk = os.read(fd, min(65536, left))
                if not chunk:
                    break
                self.remaining -= len(chunk)
                left -= len(chunk)
                chunks.append(chunk)
            data = b"".join(chunks)
            if len(data) != before.st_size or stamp(os.fstat(fd)) != stamp(before):
                raise PreservationError()
            self.files[relative] = (fd, stamp(before), data)
            return data
        except BaseException:
            os.close(fd)
            raise

    def metadata(self, relative):
        value = json.loads(self.read(relative), object_pairs_hook=strict_object)
        if not isinstance(value, dict):
            raise PreservationError()
        return value

    def finish(self):
        if stamp(os.fstat(self.fd)) != self.root_stamp or stamp(self.root.stat()) != self.root_stamp:
            raise PreservationError()
        for relative, (fd, before, _) in self.files.items():
            current = self.open(relative)
            try:
                if stamp(os.fstat(fd)) != before or stamp(os.fstat(current)) != before:
                    raise PreservationError()
            finally:
                os.close(current)


def checked_bytes(files, record):
    if not isinstance(record, dict) or not isinstance(record.get("sha256"), str) \
            or not HASH.fullmatch(record["sha256"]) or type(record.get("bytes")) is not int or record["bytes"] < 0:
        raise PreservationError()
    data = files.read(record.get("path"))
    if len(data) != record["bytes"] or digest(data) != record["sha256"]:
        raise PreservationError()
    return data


def transfer_encoding(part):
    # A parser choosing the first contradictory header is not native proof of
    # which structure or decoding was intended by the archived source.
    for field in ("Content-Type", "Content-Transfer-Encoding", "Content-Disposition"):
        if len(part.get_all(field, [])) > 1:
            raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
    header = part.get("Content-Transfer-Encoding")
    encoding = getattr(header, "cte", None) if header is not None else "7bit"
    if encoding not in ("7bit", "8bit", "binary", "base64", "quoted-printable"):
        raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
    return encoding


def quoted_printable(data):
    """Qualify hex octets and soft breaks, then use the standard decoder.

    RFC2045 section6.7 permits transport padding and local line conventions.
    CRLF and LF are supported here; bare CR and overlong encoded lines refuse.
    Lowercase hex is handled explicitly as its corresponding uppercase octet.
    This bounded profile is not a claim of complete MIME conformance.
    """
    normalized = []
    for physical in io.BytesIO(data):
        ending = b"\r\n" if physical.endswith(b"\r\n") else b"\n" if physical.endswith(b"\n") else b""
        line = (physical[:-len(ending)] if ending else physical).rstrip(b" \t")
        if len(line) > 76:
            raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
        index = 0
        while index < len(line):
            value = line[index]
            if value == 61:
                if index == len(line) - 1 and ending:
                    index += 1
                elif index + 2 < len(line) and all(value in b"0123456789ABCDEFabcdef" for value in line[index + 1:index + 3]):
                    index += 3
                else:
                    raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
            elif value in (9, 32) or 33 <= value <= 60 or 62 <= value <= 126:
                index += 1
            else:
                raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
        normalized.append(line + ending)
    return quopri.decodestring(b"".join(normalized))


def decoded_payload(part, encoding):
    try:
        if encoding in ("base64", "quoted-printable"):
            # email.get_payload(decode=True) repairs malformed transfer data
            # and ignores the parsed CTE token when comments surround it.
            # Qualify the actual ASCII wire payload before explicitly decoding.
            wire = part.get_payload(decode=False)
            if not isinstance(wire, str):
                raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
            wire = wire.encode("ascii", errors="strict")
            if encoding == "quoted-printable":
                return quoted_printable(wire)
            encoded = re.sub(rb"[ \t\r\n]", b"", wire)
            decoded = base64.b64decode(encoded, validate=True)
            if base64.b64encode(decoded) != encoded:
                raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
            return decoded
        payload = part.get_payload(decode=True)
        if not isinstance(payload, bytes) or encoding == "7bit" and any(value > 127 for value in payload):
            raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
        return payload
    except (UnicodeError, ValueError, binascii.Error):
        raise PreservationError("SECRETARY_PRESERVATION_MIME", 409) from None


def mime_scope(data):
    message = email.message_from_bytes(data, policy=policy.default)
    stack, visited, decoded, attachments, total = [(message, 0)], 0, 0, [], 0
    while stack:
        part, depth = stack.pop(); visited += 1
        if visited > MAX_PARTS or depth > 64:
            raise PreservationError("SECRETARY_PRESERVATION_TOO_LARGE", 413)
        if part.defects or any(getattr(value, "defects", ()) for _, value in part.items()):
            raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
        encoding = transfer_encoding(part)
        if part.get_content_type() == "message/rfc822":
            # The email library does not expose the original encoded bytes of
            # this container without serialization. Do not substitute new bytes.
            raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
        if part.is_multipart():
            if encoding not in ("7bit", "8bit", "binary"):
                raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
            stack.extend((child, depth + 1) for child in reversed(list(part.iter_parts())))
            continue
        payload = decoded_payload(part, encoding)
        if not isinstance(payload, bytes) or part.defects:
            raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
        total += len(payload)
        if total > MAX_BYTES:
            raise PreservationError("SECRETARY_PRESERVATION_TOO_LARGE", 413)
        if part.get_content_maintype() == "text":
            charset = part.get_content_charset() or "ascii"
            payload.decode(CHARSET_ALIASES.get(charset, charset), errors="strict")
        decoded += 1
        if part.get_filename() is not None or part.get_content_disposition() == "attachment" \
                or part.get_content_type() not in ("text/plain", "text/html"):
            attachments.append((digest(payload), len(payload)))
            if len(attachments) > MAX_ATTACHMENTS:
                raise PreservationError("SECRETARY_PRESERVATION_TOO_LARGE", 413)
    if not decoded:
        raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
    return message, decoded, attachments


def _probe(root, message_id, thread_id, source_sha256, request_id):
    files = SourceFiles(root)
    try:
        receipt = files.metadata(f"raw-receipts/{message_id}.json")
        if any(receipt.get(key) != value for key, value in (
                ("messageId", message_id), ("threadId", thread_id), ("sha256", source_sha256))):
            raise PreservationError()
        manifest = files.metadata(f"threads/{thread_id}/manifest.json")
        messages = manifest.get("messages")
        if manifest.get("threadId") != thread_id or not isinstance(messages, list) \
                or any(not isinstance(row, dict) for row in messages):
            raise PreservationError()
        selected = [row for row in messages if row.get("id") == message_id]
        if len(selected) != 1:
            raise PreservationError()
        selected = selected[0]
        attached = selected.get("attachments")
        if not isinstance(attached, list):
            raise PreservationError()
        if len(attached) > MAX_ATTACHMENTS:
            raise PreservationError("SECRETARY_PRESERVATION_TOO_LARGE", 413)
        raw = checked_bytes(files, receipt)
        if not raw:
            raise PreservationError()
        message, parts_decoded, decoded_attachments = mime_scope(raw)
        headers = selected.get("headers", {})
        if not isinstance(headers, dict):
            raise PreservationError()
        expected_id = headers.get("message-id")
        if expected_id is not None and (not isinstance(expected_id, str) \
                or " ".join(expected_id.split()) != " ".join(str(message.get("Message-ID") or "").split())):
            raise PreservationError()
        attachments, part_ids = [], set()
        for record in attached:
            part_id = record.get("partId") if isinstance(record, dict) else None
            if not isinstance(part_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", part_id) or part_id in part_ids:
                raise PreservationError()
            checked_bytes(files, record); part_ids.add(part_id)
            attachments.append({"partId": part_id, "sha256": record["sha256"], "bytes": record["bytes"]})
        if len(raw) + sum(item["bytes"] for item in attachments) > MAX_BYTES:
            # The public packet's declared scope also stays within the bound,
            # including duplicate content at different MIME part identities.
            raise PreservationError("SECRETARY_PRESERVATION_TOO_LARGE", 413)
        if Counter((item["sha256"], item["bytes"]) for item in attachments) != Counter(decoded_attachments):
            raise PreservationError("SECRETARY_PRESERVATION_MIME", 409)
        try:
            machine_fd = os.open(MACHINE_ID_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            raise PreservationError("SECRETARY_PRESERVATION_IDENTITY", 503) from None
        try:
            machine_stat = os.fstat(machine_fd)
            if not stat.S_ISREG(machine_stat.st_mode) or machine_stat.st_size > 4096:
                raise PreservationError("SECRETARY_PRESERVATION_IDENTITY", 503)
            if machine_stat.st_size > files.remaining:
                raise PreservationError("SECRETARY_PRESERVATION_TOO_LARGE", 413)
            machine = os.read(machine_fd, machine_stat.st_size)
            if stamp(os.fstat(machine_fd)) != stamp(machine_stat) or len(machine) != machine_stat.st_size:
                raise PreservationError("SECRETARY_PRESERVATION_IDENTITY", 503)
        finally:
            os.close(machine_fd)
        machine = machine.strip()
        if not re.fullmatch(rb"[a-f0-9]{32}", machine) or machine == b"0" * 32:
            raise PreservationError("SECRETARY_PRESERVATION_IDENTITY", 503)
        files.finish()
        metadata = json.dumps({"threadId": thread_id, "message": selected, "rawReceipt": receipt},
                              sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
        return {"contract": CONTRACT, "requestId": request_id, "messageId": message_id, "threadId": thread_id,
                "sourceSha256": source_sha256, "machineIdSha256": digest(machine),
                "archiveIdSha256": digest(str(files.root).encode()), "raw": {"sha256": source_sha256, "bytes": len(raw)},
                "attachments": sorted(attachments, key=lambda item: item["partId"]), "metadataSha256": digest(metadata),
                "partsDecoded": parts_decoded, "attachmentsDecoded": len(decoded_attachments)}
    finally:
        files.close()


def probe(root, message_id, thread_id, source_sha256, request_id):
    if any(not isinstance(value, str) or not pattern.fullmatch(value) for pattern, value in (
            (MAIL_ID, message_id), (MAIL_ID, thread_id), (HASH, source_sha256), (UUID, request_id))):
        raise PreservationError("SECRETARY_PRESERVATION_INVALID", 400)
    try:
        return _probe(root, message_id, thread_id, source_sha256, request_id)
    except PreservationError:
        raise
    except (OSError, ValueError, TypeError, LookupError, AttributeError, RecursionError):
        raise PreservationError() from None

"""Inspect exact RFC822 bytes, without network, files, or third-party packages."""
import base64
import hashlib
import json
import sys
from email import policy
from email.parser import BytesParser


def inspect(raw):
    message = BytesParser(policy=policy.default).parsebytes(raw)
    if any(name.lower().startswith("resent-") for name in message.keys()):
        raise ValueError("Resent headers are unsupported")
    fields = {}
    for name in ("To", "Cc", "Bcc", "From"):
        headers = message.get_all(name, [])
        if len(headers) > 1 or any(header.defects for header in headers):
            raise ValueError("Ambiguous recipient headers")
        fields[name.lower()] = [address.addr_spec for header in headers for address in header.addresses]
    if not any(fields[name] for name in ("to", "cc", "bcc")) or len(fields["from"]) != 1:
        raise ValueError("Missing sender or recipients")
    if len(message.get_all("Subject", [])) > 1:
        raise ValueError("Ambiguous subject")
    # Inspect both alternatives; an HTML-only draft still has an explicit preview.
    bodies, attachments = [], []
    def visit(part):
        if part.defects:
            raise ValueError("Malformed MIME message")
        if part.get_filename() or part.get_content_disposition() == "attachment" or part.get_content_maintype() not in ("text", "multipart"):
            payload = part.get_payload(decode=True)
            if part.defects:
                raise ValueError("Malformed attachment encoding")
            attachments.append({"name": part.get_filename() or "unnamed",
                                "bytes": len(payload) if payload is not None else None})
        elif part.is_multipart():
            for child in part.iter_parts():
                visit(child)
        else:
            bodies.append(part.get_content())
            if part.defects:
                raise ValueError("Malformed body encoding")
    visit(message)
    body = "\n".join(bodies)
    return {**fields, "subject": str(message.get("Subject", "")),
            "bodyPreview": body[:80], "bodyLength": len(body),
            "attachments": len(attachments), "attachmentDetails": attachments,
            "sha256": hashlib.sha256(raw).hexdigest()}


if __name__ == "__main__":
    try:
        encoded = sys.stdin.read(40_000_001)
        if len(encoded) > 40_000_000:
            raise ValueError("Message exceeds snapshot bound")
        raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
        print(json.dumps(inspect(raw), ensure_ascii=True))
    except Exception:
        sys.exit("Cannot safely inspect the Gmail send snapshot")

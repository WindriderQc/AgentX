"""Bounded text-only RTF decoding. Documents never select code or resources."""
from __future__ import annotations

import codecs
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

PROFILE = "secretary.rtf-text/v1"
VERSION = "0.0.34"
PROCESSOR_SHA256 = "4d03d30ac6d6080dbe205a3a149be73200d7d370f866b76a65792910e79274f4"
MAX_PART_BYTES = 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024
MAX_DEPTH = 64
TIMEOUT_SECONDS = 3
MIME_TYPES = {"application/rtf", "text/rtf", "application/x-rtf"}


def is_rtf(mime_type, filename=None):
    return mime_type in MIME_TYPES or mime_type == "application/octet-stream" and str(filename or "").lower().endswith(".rtf")


class RtfError(ValueError):
    pass


def _convert(data):
    """Runs only in the bounded local Python child, not a document engine."""
    from _vendor.striprtf.striprtf import PATTERN, FONTTABLE, charset_map, font_table_group, rtf_to_text
    if not data or len(data) > MAX_PART_BYTES:
        raise RtfError("rtf-part-size-limit")
    try:
        text = data.decode("ascii", errors="strict")
    except UnicodeError as error:
        raise RtfError("rtf-raw-8bit-unsupported") from error
    if not re.match(r"\A\{\\rtf1(?=[\\\s{}])", text):
        raise RtfError("rtf-signature-invalid")
    depth, root_closed, omitted, used_fonts = 0, False, set(), set()
    fonts = font_table_group(text)
    # Use upstream's lexer/grammar, never another text-stripping parser.
    inspection = text.replace(fonts, "", 1) if fonts else text
    for token in PATTERN.finditer(text):
        word, arg, _hex, char, brace, literal = token.groups()
        if root_closed and token.group().strip():
            raise RtfError("rtf-trailing-content")
        if brace:
            depth += 1 if brace == "{" else -1
            if not 0 <= depth <= MAX_DEPTH:
                raise RtfError("rtf-structure-limit")
            if depth == 0:
                root_closed = True
        if word == "bin":
            raise RtfError("rtf-binary-unsupported")
        if word and word != word.lower():
            raise RtfError("rtf-control-case-unsupported")
        if word in {"mac", "pc", "pca"}:
            raise RtfError("rtf-default-codepage-unsupported")
        if char == "'" or literal == "\\":
            raise RtfError("rtf-escape-invalid")
        if word in {"field", "footnote", "annotation", "header", "headerf", "headerl", "headerr", "footer", "footerf", "footerl", "footerr", "shptxt", "upr", "ud"}:
            raise RtfError("rtf-text-destination-unsupported")
        if word in {"pict", "object", "objdata", "shp"}:
            omitted.add(word)
        if word == "ansicpg":
            try:
                codecs.lookup("cp" + str(int(arg)))
            except (ValueError, TypeError, LookupError) as error:
                raise RtfError("rtf-codepage-unsupported") from error
        if word == "u" and (arg is None or not -32768 <= int(arg) <= 65535) \
                or word == "uc" and (arg is None or not 0 <= int(arg) <= 16):
            raise RtfError("rtf-unicode-control-invalid")
        if literal and ord(literal) < 32 and literal not in "\t\r\n":
            raise RtfError("rtf-control-byte-invalid")
    if depth or not root_closed:
        raise RtfError("rtf-structure-invalid")
    for token in PATTERN.finditer(inspection):
        word, arg, *_ = token.groups()
        if word in {"f", "deff"} and arg is not None:
            used_fonts.add(arg)
    for font, charset, _ in FONTTABLE.findall(fonts):
        if font in used_fonts:
            try:
                codecs.lookup(charset_map[int(charset)])
            except (ValueError, KeyError, LookupError) as error:
                raise RtfError("rtf-font-codepage-unsupported") from error
    try:
        result = rtf_to_text(text, encoding="cp1252", errors="strict")
        # RTF \u values are UTF-16 code units. Combine valid pairs, reject lone
        # surrogates; do not replace or silently drop undecodable characters.
        result = result.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "strict")
        encoded = result.encode("utf-8", "strict")
    except (LookupError, UnicodeError, ValueError) as error:
        raise RtfError("rtf-text-decode-failed") from error
    if not result.strip():
        raise RtfError("rtf-no-readable-text")
    if len(encoded) > MAX_TEXT_BYTES:
        raise RtfError("rtf-text-size-limit")
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", result):
        raise RtfError("rtf-decoded-control-invalid")
    return {"ok": True, "content": result, "omittedKinds": sorted(omitted)}


def read_part(part):
    payload = part.get_payload(decode=True)
    meta = {"profile": PROFILE, "processor": "striprtf", "version": VERSION, "processorSourceSha256": PROCESSOR_SHA256,
            "scope": "rtf-text-only", "errors": "strict", "asciiTransport": True,
            "filename": str(part.get_filename() or "")[:300], "disposition": part.get_content_disposition(),
            "inputLimitBytes": MAX_PART_BYTES, "outputLimitBytes": MAX_TEXT_BYTES, "depthLimit": MAX_DEPTH}
    reason, answer = None, {}
    if not isinstance(payload, bytes):
        reason = "rtf-mime-payload-invalid"
    else:
        meta.update(decodedPartSha256=hashlib.sha256(payload).hexdigest(), decodedPartBytes=len(payload))
        if part.defects:
            reason = "rtf-mime-transfer-invalid"
        elif len(payload) > MAX_PART_BYTES:
            reason = "rtf-part-size-limit"
        else:
            try:
                call = subprocess.run([sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--convert"],
                                      input=payload, capture_output=True, timeout=TIMEOUT_SECONDS, check=False)
                answer = json.loads(call.stdout)
                if call.returncode or not isinstance(answer, dict) or answer.get("ok") is not True:
                    reason = answer.get("reason", "rtf-parser-failed") if isinstance(answer, dict) else "rtf-parser-failed"
            except subprocess.TimeoutExpired:
                reason = "rtf-parser-time-limit"
            except (OSError, ValueError):
                reason = "rtf-parser-unavailable"
    if reason:
        meta.update(status="unreadable", reason=reason)
        return {"content": "", "readable": False, "extraction": meta,
                "extractionGaps": [{"code": "rtf-text-unreadable", "reason": reason}]}
    meta.update(status="text-extracted", omittedKinds=answer["omittedKinds"])
    gaps = [{"code": "rtf-nontext-content-not-qualified", "kinds": answer["omittedKinds"]}] if answer["omittedKinds"] else []
    return {"content": answer["content"], "readable": True, "extraction": meta, "extractionGaps": gaps}


def _main():
    # Process-wide CPU/address-space limits are confined to this disposable
    # pure-Python child; they never alter the Secretary worker or model process.
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
    except ImportError:
        pass  # The parent still enforces a wall-clock timeout on other hosts.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        result = _convert(sys.stdin.buffer.read(MAX_PART_BYTES + 1))
    except RtfError as error:
        result = {"ok": False, "reason": str(error)}
    except Exception:
        result = {"ok": False, "reason": "rtf-parser-failed"}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    _main()

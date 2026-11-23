"""Restore the bounded selected current review graph through native custody."""
from __future__ import annotations

import archive_preservation as native
import archive_restoration as disk
from archive_review_packet import MAX_FILES, ReviewPacketError, qualify

CONTRACT = 'secretary.archive-review-restoration/v1'


def probe(root, message_id, thread_id, source_sha256, request_id, *, inspect_files=None):
    if any(not isinstance(value, str) or not pattern.fullmatch(value) for pattern, value in (
            (native.MAIL_ID, message_id), (native.MAIL_ID, thread_id), (native.HASH, source_sha256), (native.UUID, request_id))):
        raise ReviewPacketError('SECRETARY_REVIEW_PACKET_INVALID', 400)
    if not disk.NATIVE_PLATFORM or disk.RENAME_NOREPLACE is None:
        raise ReviewPacketError('SECRETARY_REVIEW_PACKET_UNSUPPORTED', 503)
    restored = packet = None

    def graph(files, proof):
        return qualify(files, message_id, thread_id, source_sha256, request_id)

    def verified(files, proof):
        nonlocal restored, packet
        packet = graph(files, proof)
        restored = disk.restore(files, {**proof, 'reviewPacket': packet}, qualify=graph, maximum_files=MAX_FILES)
        if inspect_files is not None:
            files.finish()
            inspect_files(files, {**proof, 'contract': CONTRACT, 'reviewPacket': packet, 'restoration': restored})
            files.finish()

    try:
        proof = native._probe(root, message_id, thread_id, source_sha256, request_id, inspect_files=verified)
        if restored is None or packet is None: raise ReviewPacketError()
        return {**proof, 'contract': CONTRACT, 'reviewPacket': packet, 'restoration': restored}
    except ReviewPacketError:
        raise
    except (native.PreservationError, disk.RestorationError) as error:
        raise ReviewPacketError('SECRETARY_REVIEW_PACKET_TOO_LARGE' if error.status == 413
                               else 'SECRETARY_REVIEW_PACKET_INTEGRITY', error.status) from None
    except OSError:
        raise ReviewPacketError('SECRETARY_REVIEW_PACKET_UNAVAILABLE', 503) from None
    except (ValueError, TypeError, LookupError, AttributeError, RecursionError, RuntimeError):
        raise ReviewPacketError() from None

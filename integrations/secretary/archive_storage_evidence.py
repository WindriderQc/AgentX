"""Bind local device observations to a successfully restored current review set.

This evidence never accepts physical independence or authorizes cleanup. It
reuses restoration custody and its source descriptor/byte fences unchanged.
"""
from __future__ import annotations

import archive_restoration as disk
import archive_review_restoration as review
import archive_storage_topology as topology
from archive_review_packet import ReviewPacketError

CONTRACT = 'secretary.archive-storage-evidence/v1'


def probe(root, message_id, thread_id, source_sha256, request_id):
    storage = None

    def inspect(files, proof):
        nonlocal storage
        rows = disk.file_set(files)
        restoration = proof['restoration']
        if len(rows) != restoration['filesCopied'] or disk.set_hash(rows) != restoration['sourceFilesSha256']:
            raise ReviewPacketError()
        files.finish()
        first, signature = topology.capture(files)
        files.finish()
        second, later = topology.capture(files)
        files.finish()
        if first != second or signature != later:
            second = {'physicalDiskIdsSha256': [], 'blockers': ['kernel_metadata_changed']}
        storage = {'contract': topology.CONTRACT, 'scope': topology.SCOPE,
                   'status': 'unqualified' if second['blockers'] else 'observed_local_devices',
                   'files': len(rows), 'filesSha256': restoration['sourceFilesSha256'], **second,
                   'physicalIndependenceAccepted': False}

    proof = review.probe(root, message_id, thread_id, source_sha256, request_id, inspect_files=inspect)
    if storage is None:
        raise ReviewPacketError()
    return {**proof, 'contract': CONTRACT, 'storage': storage}

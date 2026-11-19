"""Bind retained current graph restores to this exact private local graph."""
from __future__ import annotations

import uuid

from archive_review_packet import inventory
from native_history_decisions import digest
from native_history_restoration_scope import capture as capture_restoration, selection


def selected_findings(saved, checks, findings):
    selected = selection(saved, checks)
    by_message = {row['reference']['messageId']: row for row in findings}
    if len(by_message) != len(findings) or set(by_message) != {row['source']['messageId'] for row in selected}:
        raise ValueError('The complete native review finding scope is unavailable')
    return by_message


def bind_local(saved, checks, archive, findings, observed):
    """Recheck local bytes against an already observed native restoration scope.

    This performs no HTTP and creates no native proof. The caller obtains the
    scope through the native restoration or review-manifest capture first.
    """
    by_message = selected_findings(saved, checks, findings)
    for member in observed['snapshot']['members']:
        ref = member['source']; finding = by_message[ref['messageId']]
        try:
            local = inventory(archive.root, ref['messageId'], ref['threadId'], ref['sourceSha256'], str(uuid.uuid4()))
        except (OSError, ValueError, TypeError, LookupError, RuntimeError):
            raise ValueError('The exact local current review graph is unavailable') from None
        if finding['reference'] != ref or finding['snapshot']['reference'] != ref \
                or digest(finding['snapshot']) != finding['fingerprint'] \
                or any(local[key] != finding['snapshot']['inventory'][key] for key in ('evidenceHash', 'reviewSha256')) \
                or any(digest(copy['content']['reviewPacket']) != digest(local) for copy in member['snapshot']['copies']):
            raise ValueError('The restored native graph no longer matches current local review evidence')
    return observed


def capture(core, saved, checks, archive, findings, **options):
    selected_findings(saved, checks, findings)
    observed = capture_restoration(core, saved, checks, review_packet=True, **options)
    # Runs after every native restore, before the caller's final Core/archive
    # fence. Local files cannot be accepted by supplying their own attestations.
    return bind_local(saved, checks, archive, findings, observed)

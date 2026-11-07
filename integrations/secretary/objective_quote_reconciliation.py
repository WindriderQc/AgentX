"""Withhold repeated readings of the exact same assertion before publication.

This is source reconciliation, never a semantic fact merge or resolution.
All model results and exported interpretations remain present for review.
"""
from pathlib import Path

from evidence_store import load
from review_attempts import durable, hashed

CONTRACT = "secretary.objective-quote-reconciliation/v1"


def reconcile(objective, manifest, findings):
    if not manifest.get("attributionContract"):
        return
    groups = {}
    for finding in findings:
        citations = (finding.get("quoteAttribution") or {}).get("citations", [])
        if not citations or any(not c.get("assertionKey") for c in citations):
            continue
        native = finding["nativeSourceRefs"][0]
        keys = sorted({c["assertionKey"] for c in citations})
        scope = [manifest["objectiveSha256"], native["system"], native["threadId"], keys]
        groups.setdefault(hashed(scope), []).append((finding, keys))
    for key, group in groups.items():
        file = Path(objective) / "quote-reconciliation" / (key + ".json")
        candidates = {finding["id"] for finding, _ in group}
        if file.exists():
            receipt = load(file, {})
            if receipt.get("schema") != CONTRACT or receipt.get("objectiveSha256") != manifest["objectiveSha256"] \
                    or receipt.get("key") != key or receipt.get("assertionKeys") != group[0][1] \
                    or receipt.get("canonicalFindingId") not in candidates:
                raise ValueError("Frozen quote reconciliation differs from retained findings")
        else:
            # Prefer the original when present in this first export. Once
            # exported, its identity stays fixed across later chunks/replays.
            ranked = sorted(group, key=lambda pair: (
                any(c["state"] != "container" for c in pair[0]["quoteAttribution"]["citations"]), pair[0]["id"]))
            receipt = {"schema": CONTRACT, "objectiveSha256": manifest["objectiveSha256"],
                       "key": key, "assertionKeys": group[0][1], "canonicalFindingId": ranked[0][0]["id"]}
            durable(file, receipt, exclusive=True)
        for finding, _ in group:
            finding["quoteReconciliation"] = {**receipt,
                "state": "canonical" if finding["id"] == receipt["canonicalFindingId"] else "withheld-repeat",
                "scope": "Same exact source assertion; interpretations are not merged or confirmed."}

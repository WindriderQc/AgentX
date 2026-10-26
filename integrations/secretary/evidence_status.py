"""Source coverage and unsettled analysis remain distinct in native progress."""
from evidence_inventory import collection_status
from evidence_store import now, save
from review_attempts import unsettled, blocked_counts


def native_status(archive, queries):
    manifests = archive.manifests()
    read = {file.stem for file in (archive.root / "page-reviews").glob("*.json")}
    pending = sum(page["pageId"] not in read for manifest in manifests for page in archive.review_pages(manifest))
    collection = collection_status(archive, queries, manifests)
    held = unsettled(archive.root)
    state = {"at": now(), "pendingTextPages": pending, "reviewedPages": len(read),
             **blocked_counts(held), **collection,
             "pending": bool(pending or collection["uncollectedThreads"] or collection["discoveringScopes"] or held)}
    save(archive.root / "native-status.json", state)
    return state

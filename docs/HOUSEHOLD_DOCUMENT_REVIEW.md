# Household document review

Core stages private document candidates at `/dad/documents`, linked from the
personal Household navigation. The configured archive owns the source originals;
Core owns review snapshots and receipts; RAG owns the approved derivative.
Staging and selection call no model and add nothing to retrieval.

## Access and explicit sharing

The existing personal private-LAN entrance serves this human workflow. It does
not verify a person's identity or age. The reviewer supplies a declared name;
Core records `identityVerified: false`. Family-pinned devices retain their
existing restriction. Family routes and both MCP buses expose no staging,
selection or promotion action. Opening an unpinned family page does not confer
or revoke personal access; see [the LAN contract](PARENTAL_ACCESS.md).

1. **Prepare** reads one explicitly configured export into a private Core
   candidate, preserving exact text, original SHA-256, location, classification,
   references, tags and dates. It never edits the original.
2. **Review** displays the entire text and metadata as untrusted data. A person
   selects the exact revision or puts it aside. Putting aside retains the
   snapshot and allows later selection. Changed sources require a new snapshot.
3. **Confirm sharing** separately approves a copy of the entire reviewed text
   as `household/normal`, including when the original is private. The original's
   labels remain unchanged. There is no automatic redaction or inferred consent.
   Review binds the existing target configuration; a changed target requires
   selection again.
4. Core writes through its existing RAG client into the existing
   `householdDocuments.source`. It requires the Nestor knowledge configuration
   to be active, retrieval enabled and the family lane included. It creates no
   parallel corpus manifest and never enables retrieval or changes configuration.

The running reader and the configured target must share the same knowledge
configuration. A changed file refuses promotion until that configuration is
served by the reader; a restart never carries an old selection onto a new target.

The manifest-verified Nestor corpus and approved household source retain their
existing readers. Family retrieval still requires household/normal labels,
the configured source and lane, and current validity. Retrieval is separate
from the human selection and sharing decisions.

## Private instance configuration

The adapter reads `config/household-document-candidates.json` under
`AGENTX_INSTANCE_ROOT` (otherwise `/etc/agentx`). A missing file disables intake;
an invalid file refuses it. The instance supplies read-only mounts for both the
configuration and archive. Configuration does not scan or ingest any directory.

Synthetic format example, to keep outside the product repository:

```json
{
  "schemaVersion": 1,
  "archiveId": "example-archive",
  "root": "/private/example-exports",
  "documents": [{
    "id": "manual",
    "relativePath": "manual.md",
    "title": "Example household manual",
    "scope": "owner",
    "sensitivity": "private",
    "validFrom": null,
    "expiresAt": "2027-12-01T00:00:00Z",
    "sourceRefs": [{ "system": "archive", "id": "example-original" }],
    "tags": ["manual"]
  }]
}
```

Up to 100 explicit UTF-8 `.md`/`.txt` exports are supported, each at most 1 MiB.
Pages contain 20 entries and return the next offset. Paths come only from this
configuration. Traversal, symlinks, nonregular files, binary or invalid UTF-8
data, empty text and changing files refuse intake. PDF/OCR extraction, recursive
discovery and archive cleanup are outside this adapter. Markdown remains the
complete source text; frontmatter does not override configured classification.

`validFrom` stays unknown when absent. The earlier of `expiresAt` and
`invalidatedAt` becomes the derivative's RAG `invalidatedAt`, which existing
retrieval excludes once reached. Superseded or expired sources cannot be
selected or promoted. Core rereads the original and metadata before selection
and dispatch. Source edits after promotion do not silently replace or retract
the derivative; later retirement uses the existing RAG controls.

Private locations and original references stay in Core. RAG receives the
approved text, tags, fact/expiry dates and one opaque
`sourceRefs: [{ "system": "household-review", "id": "<candidate id>" }]` link.
The retained candidate contains complete original provenance and classification.

## Receipts and uncertain results

`household_document_candidates` contains private Core review snapshots, excluded
from every recall path. Under `/api/voice-personas/private/document-candidates`:

- `GET/POST /` lists/stages candidates; staging takes `sourceId` only.
- `GET /sources` lists configured exports; `GET /:id` reads a snapshot.
- `POST /:id/review` takes `expectedRevision`, `decision` (`select` or `dismiss`)
  and the declared `reviewer`.
- `POST /:id/promote` takes the reviewed revision, stable UUID `requestId` and
  exact `confirmation: "SHARE <candidate id>"`.

The browser retains the UUID before its first request. Core atomically records
one dispatch identity before calling RAG; a unique index prevents its reuse for
another candidate. Duplicates reconcile the same target without new ingestion.
A completed write response alone does not mark promotion complete. Core reads
the exact RAG document and checks content SHA-256, complete revision, source,
labels, dates, tags and review reference. RAG document reads expose
`contentHash` and `mixedRevision` for this check; older versions lacking that
evidence leave results unconfirmed.

A crash, missing response, unavailable result or incomplete write retains
`dispatching`/`uncertain`. Refresh reconciles by the original identity and never
resends an ambiguous ingestion. A new UUID, dismissal or reselection cannot
clear that fence. Missing results need native operator reconciliation before
any separately authorized repair. A receipt records the observed RAG revision
and time, not permanent source freshness or real-device acceptance.

## Qualification

Source tests use synthetic exports, disposable MongoDB and a fake RAG transport.
Containers, deployment, actual corpus selection, queued ingestion and family
retrieval/device acceptance are separate. Configuring an archive does not
authorize an import. The instance selects and accepts its real corpus in its
private workflow; private content and receipts stay outside this repository.

# Explicit human semantic review

Core offers a separate human judgment on the exact selected originals,
attachments and recorded analyses at `/dad/history`, after an existing manifest
confirmation. The existing inspection receipt and source-page delivery receipts
keep their original meaning. Neither becomes semantic acceptance implicitly.

This uses the existing private-LAN owner surface, with `authenticatedPerson:null`.
It adds no authenticated identity, tool grant, model campaign or mailbox effect.
Human semantic judgment is separate from automatic Secretary qualification and
from any later explicit authorization to move selected messages to Trash.

## Source delivery and judgment

`secretary.archive-semantic-review/v1` reuses the native original/MIME/attachment
reader and the current review-file graph on the same retained file descriptors.
The complete byte fence runs after resource generation. It reads no provider,
downloads nothing and writes no archive file.

The native resource list contains the original RFC822 bytes, every recorded
attachment, cached file members of compound attachments, and one selected
analysis JSON document. That document contains complete selected finding objects
and their identities, unresolved thread questions, and every selected source page
with its recorded page review. It omits other message objects and findings from
the thread. Its hashes bind the projection to the exact current native graph.
Required external links are not fetched; if they are needed to understand the
source, the human must leave the selection held.

The caller selects bounded source/resource ordinals and byte offsets, never a
file path or host. Chunks are at most 32 KiB. The browser verifies chunk hashes
and the complete resource hash. Analysis is displayed as escaped text; originals
and attachments download as inert octet streams for examination in an appropriate
reader. A download or page delivery proves delivery, not understanding.

The human explicitly chooses either `accepted_selected_semantics` or
`held_ambiguous`. Acceptance asserts that the originals, attachments and recorded
analyses have actually been examined, relevant information is faithfully
represented, and no unresolved ambiguity or necessary reading remains. It
requires delivery of every resource and no native unresolved thread question.
Unreadable sources, missing native artifacts or changed bindings remain blocked.
The human verdict does not itself resolve open actions, invoices or deliveries.

## Native identity and recovery

The human ledger is `agentx.history-human-semantic-review/v1`:

| Method and route under `/api/secretary/history` | Meaning |
| --- | --- |
| `POST /manifest-confirmations/:manifestId/semantic-reviews` | Reserve a new semantic UUID for exact `{requestId,checks,before}` |
| `GET /semantic-reviews/:requestId` | Historical opaque receipt, without sources or preview |
| `POST /semantic-reviews/:requestId/reopen` | Revalidate `{manifestRequestId,checks,before}` and display exact resources |
| `POST /semantic-reviews/:requestId/read` | Same scope plus `{source,resource,offset}`; native delivery and coverage |
| `POST /semantic-reviews/:requestId/decide` | Same scope plus `{bindingSha256,decision}`; explicit human judgment |

The binding includes the original confirmed human manifest, current full Core
restoration and manifest hashes, and all resource descriptors. It is stored in a
separate metadata-only ledger, so reading progress cannot invalidate its own
Entry/MemoryNote restoration proof. No private text, source references or file
paths are stored in this ledger. Coverage uses versioned conditional writes;
offsets cannot skip bytes. Earlier offsets can be reread after an uncertain page
response. A decision reserves its exact identity before native work. An uncertain
reservation stays pending and is never taken over or relaunched automatically.

The browser journals its identity, frozen scope, binding and decision before
writes. Lost acknowledgements are reconciled by GET of that original UUID.
Reloading requires explicit reopening and fresh resource delivery in the browser;
neither old progress nor a changed selection sends a new decision. Storage failure
or replacement of the browser journal prevents writes.

The receipt remains historical with `semanticAcceptance:false`. This prevents a
saved human verdict from asserting current source availability after an edit or
erasure. Ledger bookkeeping never changes the original inspection receipt or
canonical historical assertions.

## Current acceptance

`POST /manifest-confirmations/:manifestId/semantic-acceptance` takes only
`{semanticRequestId,checks,before,observationId,expected?}`. The separate semantic
UUID is mandatory. It composes the existing preservation/decision acceptance,
rechecks the exact semantic resources and human binding, rereads the semantic
receipt, and ends with the complete native Core/index/privacy fence after all
producers and ledger reads.

The `agentx.history-semantic-acceptance/v1` snapshot contains its exact review
binding, historical receipt and preservation-child fingerprint. Only a complete,
accepted human judgment on those current exact resources removes
`native_semantic_acceptance_unavailable`. The older v13–v15 contracts are
unchanged. The two other acceptance flags remain independent: a human semantic
verdict does not establish physical preservation or close an invoice.

Even if semantic, preservation and decision acceptance all succeed,
`native_manifest_approval_binding_unavailable` remains. All receipts and current
observations retain `approvalBound:false`, `executionAllowed:false`,
`cleanupStatus:'blocked'` and `mailboxEffects:0`. No cleanup executor is included.
Synthetic native-file, Mongo, HTTP and browser tests qualify the code path;
they do not qualify an installed private corpus or an actual person's judgment.

## Private reconciliation v16

`retention_reconcile.py --native-semantic-acceptance <semantic-UUID>` requires
`--native-manifest-confirmation <original-manifest-UUID>`. These are separate
identities. Optional v14/v15 flags, if supplied, must retain the original
manifest identity. V16 implies the existing complete v11/v12 prerequisites and
performs exactly two fresh semantic-parent POSTs, with no standalone v13–v15
observation calls or automatic retry.

The client reconstructs the exact human/resource binding and gap policy,
validates every nested P/D/current/storage observation, and requires stable
fingerprints and monotone dates across both passes. The snapshot is bounded to
1 MiB and the response to 3 MiB, with a 1,800-second request timeout. Existing
local archive/disposition/graph fences follow these final HTTP observations.
The immutable report remains private, stdout exports only counts/status/gap
codes, and the command always exits 2. The consumer cannot prepare a human
verdict, approve it or execute a mailbox effect.

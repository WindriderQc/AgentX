# Selected native preservation acceptance

This contract applies the selected-scope rule: native machine and whole-device
identities must be distinct, current original/review files must restore, and
ambiguous evidence must remain held. It composes the existing
[decision acceptance](SECRETARY_DECISION_ACCEPTANCE.md),
[storage observations](SECRETARY_STORAGE_EVIDENCE.md) and full selected
[Core record/index restoration](SECRETARY_CORE_RESTORATION.md). It accepts no
caller-supplied topology, source proof or outcome.

`POST /api/secretary/history/manifest-confirmations/:requestId/preservation-acceptance`
uses the original human UUID, retained `checks`, canonical UTC `before` and a
fresh `observationId`. Optional `expected`, `expectedDecision`, `expectedCurrent`
and `expectedStorage` compare the parent and child fingerprints separately.
The existing owner human/family-pin boundary applies to all components. The
reader exposes no MCP tool, new grant or permission. Responses are private and
uncached metadata; no source body, embedding, host path or raw disk identifier
is returned.

Core first recomposes the current human-bound manifest, its full Core
document/index restoration and its recorded-decision policy. It then observes
both operator-selected archive copies in two complete storage passes. Every
storage member must match the exact manifest reference, Core pins and each
copy's original/MIME/review/restoration metadata. After all storage producers,
Core rereads the immutable human receipt and checks it against the original.
The last awaited evidence read is the full Core data/index/note/privacy fence;
only synchronous policy calculation follows. No confirmation or decision is
created or changed by this operation.

Across the entire selected set, each copy label must retain the same native
machine/archive identity. Core takes the union of all observed whole-device
hashes for `primary` and separately for `mirror`. An overlap between these
unions holds the entire selection, including overlap that occurs only across
different messages. Unknown topology, held native members, inconsistent copy
identities or a changed human binding also hold it. Missing, malformed, partial
or contradictory binding data returns unavailable rather than partial success.

## Independent acceptance flags

The contract is `agentx.history-preservation-acceptance/v1`, under policy
`native-distinct-machines-and-whole-devices/v1`. Its stable snapshot binds both
child fingerprints, the manifest, full Core restoration, exact selection and
cutoff. It contains aggregated copy identities/device hashes, counts, sorted
blocker codes and the two acceptance decisions.

| Preservation | Recorded decisions | Remaining generic gaps |
| --- | --- | --- |
| Accepted | Accepted | Semantic acceptance and mailbox approval |
| Accepted | Held | Decision reconciliation, semantic acceptance and mailbox approval |
| Held | Accepted | Preservation, semantic acceptance and mailbox approval |
| Held | Held | All four |

An open invoice cannot become a closed decision merely because its originals
are preserved. Conversely, a pending decision does not erase a verified
preservation observation. A current original human binding is required for
preservation acceptance. `counts.heldMessages` counts individual storage-member
holds; a cross-message overlap can hold the whole selection with zero such
members. The parent status and blocker list retain that distinction.

`preservationAccepted` removes only
`native_preservation_acceptance_unavailable` for this exact selected report.
Decision acceptance independently removes its own gap. Raw storage-v1 results
keep their false physical-acceptance flag and four generic gaps; v13/v14 and
other older contracts keep their existing behavior.

Snapshot capacity is 64 KiB; the complete response, containing each child once,
is bounded to 2 MiB. Larger complete evidence refuses without truncation.
`authenticatedPerson` remains null, `semanticAcceptance`, `approvalBound` and
`executionAllowed` stay false, `mailboxEffects` is zero and cleanup stays
blocked. No mailbox executor or canonical restore is introduced.

## Private reconciliation v15

`retention_reconcile.py --native-preservation-acceptance <original-human-UUID>`
requires retained native review-restoration checks and implies the existing
v11/v12 evidence. Any supplied v13/v14 UUID must equal that same identity before
HTTP starts. The client independently reconstructs the whole-device policy from
the already verified graph and validates both embedded native child envelopes.

V15 performs exactly two fresh parent HTTP observations, with no separate
decision-acceptance, storage-scope or current-confirmation request. Both complete
snapshots and parent/child identities, dates and fingerprints must agree. Each
request has a 1,800-second timeout and a 2 MiB response bound, with no automatic
retry. These are the last HTTP calls; existing local archive/disposition/graph
fences follow. Unavailable or stale human evidence writes no success report;
current but ambiguous storage can produce a held report. The immutable report
remains private and stdout contains counts/status/gap codes only.

V15 always exits 2. It records conditional acceptance under the trusted native
OS/kernel view, not hardware attestation, independent infrastructure/enclosure
guarantees or whole-Core disaster recovery. The Core proof covers a temporary
roundtrip of current selected documents and supported index definitions, not a
new durable Core backup or recall-index qualification. Source code and synthetic
tests do not qualify an installed archive or disk. No deployment, instance
change, model/GPU campaign or real cleanup follows from the contract.

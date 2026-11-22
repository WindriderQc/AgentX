# Current native binding of a human manifest confirmation

The [human confirmation receipt](SECRETARY_MANIFEST_CONFIRMATION.md) records a
historical inspection. Its ordinary `GET` does not recheck source availability.
An optional native observation binds that same confirmed identity to the current
selected review manifest and complete Core BSON/index restoration. It never
prepares, confirms, replaces or upgrades a human receipt.

`POST /api/secretary/history/manifest-confirmations/:requestId/current` accepts
only the original retained `checks`, canonical UTC `before`, a fresh observation
UUID `observationId` and optional expected observation fingerprint. The original
human UUID remains in the path. The existing owner human audience and family-pin
boundary apply; no MCP tool or permission exposes a new action. Responses use
`Cache-Control: private, no-store`.

Core validates the complete selection against the original input digest before
native calls. It requires a confirmed receipt with ordered preparation and
confirmation dates. It then recomposes its existing native review manifest and
full selected Core restoration, rereads the original receipt and requires its
immutable metadata to agree. The final full Core source/index/privacy fence
follows all metadata awaits. No asynchronous evidence read follows that fence.
The operation writes no confirmation, source or decision. Native temporary-copy
custody and removal retain their existing controls.

| Observation | Meaning |
| --- | --- |
| `snapshot.confirmationStatus: current` | Complete native evidence matches both fingerprints bound by the original human inspection |
| `snapshot.confirmationStatus: changed` | A complete current native composition has a different binding; the historical receipt is retained unchanged |
| Unavailable response | Complete evidence cannot be established; no missing, changed or current source is inferred |
| Unknown/unconfirmed original identity | No current verification starts; no receipt is created or recovered by replacement |

Legacy native readers can return HTTP 409 for a mirror outage or temporary
storage failure. The current-binding reader reports those incomplete native
observations as unavailable HTTP 503. It does not turn the legacy status into a
proven change. A later explicit observation can qualify the same original human
receipt if complete evidence is available and still matches.

The response contract is `agentx.history-manifest-confirmation-current/v1`.
Its snapshot contains only the original UUID, canonical cutoff, selection/input
hashes, selected-message count, confirmed receipt metadata, current component
hashes and the separate confirmation status. It contains no source references,
body, embeddings, restored names or preview. Metadata is bounded to 16 KiB.
The outer `status` describes comparison with the optional expected observation
fingerprint; even `observed_match` cannot make a changed human binding current.
These native observations are not an atomic cross-service snapshot.

## Optional private reconciliation v13

`retention_reconcile.py --native-manifest-confirmation <original-human-UUID>`
selects `agentx.secretary-retention-reconciliation/v13`. It requires the existing
`--native-review-restoration-checks` input and implies the v11 review manifest and
v12 full Core restoration. Malformed identities and incomplete retained scope
refuse before the first HTTP request. Earlier modes retain their meanings.

The consumer reconstructs the complete verified v11 manifest and validates v12
bindings and restoration metadata locally. It then performs two fresh native
current-binding observations without retries. Each response is limited to 64 KiB
and 1,200 seconds. Both observations must preserve the original human identity,
dates and full snapshot; all component/input/selection fingerprints must match
the already verified graph and `confirmationStatus` must be `current`. Strict
types, canonical dates, fixed review-only flags and the four native gaps remain
required. A caller-supplied local attestation cannot substitute for these reads.

These are the final HTTP calls. Only local archive-disposition and applicable
review-file graph fences follow, using the already observed Core rows. Changed
or incomplete evidence writes no success report. The new report remains private
and immutable; stdout contains counts and current-status summary only, without
human request IDs or fingerprints.

V13 still exits 2. Current human inspection establishes neither semantic
acceptance, independent storage acceptance, reconciled decisions nor mailbox
approval. `authenticatedPerson` remains null, `approvalBound` and
`executionAllowed` remain false, `mailboxEffects` remains zero and cleanup stays
blocked with all four global native acceptance gaps. No real campaign, model,
deployment, instance change or mailbox effect follows from this contract.

The optional [selected recorded-decision acceptance](SECRETARY_DECISION_ACCEPTANCE.md)
reuses this same native current-binding reader with a separate policy and private
v14 report. The v13 response and its four gaps retain their existing meanings.

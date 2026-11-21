# Human confirmation of an exact selected manifest

The history page offers a human confirmation of the exact selected review
evidence. It uses the existing private-LAN human boundary. It establishes no
authenticated person or independent reviewer, changes no permission and performs
no mailbox action. A confirmation is a historical reading receipt; it is not
semantic acceptance or authorization to clean up mail.

The owner selects historical assertions and a cutoff. The browser collects the
latest current retained review-restoration receipt for each exact Gmail source
in that selection, without silently omitting an unmatched assertion or source.
Preparation refuses missing or incompatible retained evidence; it does not launch
new preservation receipts. The native preview presents the selected evidence,
coverage and remaining blockers before the explicit confirmation.

## Core contract

All four operations belong to the existing owner Secretary human surface and
return `Cache-Control: private, no-store`. Family scope refuses before storage
or native access. No MCP tool exposes preparation or confirmation.

| Operation | Input | Meaning |
| --- | --- | --- |
| `POST /api/secretary/history/manifest-confirmations` | Original UUID `requestId`, exact retained v3 `checks`, canonical UTC `before` | Reserve the identity, then prepare native evidence once |
| `GET /api/secretary/history/manifest-confirmations/:requestId` | Original UUID | Observe the original historical state; perform no native verification |
| `POST /api/secretary/history/manifest-confirmations/:requestId/reopen` | Original `checks`, `before` | Explicitly reopen only a prepared, unchanged original preview |
| `POST /api/secretary/history/manifest-confirmations/:requestId/confirm` | Original `checks`, `before`, displayed `bindingSha256`, `confirmation: reviewed_selected_manifest` | Reserve confirmation once, freshly verify the evidence and retain its receipt |

The contract is `agentx.history-manifest-confirmation/v1`. Core composes its
existing native review manifest with selected full BSON/index restoration.
Restoration must bind the manifest's exact downstream selection. The composite
binding is the canonical digest of `{contract, manifestSha256,
coreRestorationSha256}`. No supplied snapshot, actor, authority or approval flag
can replace those native observations. A changed source, body, vector, index,
selection or cutoff cannot be substituted under the original identity.

Native Mongo `_id` uniqueness reserves preparation before its first native call.
Only the winning reservation runs it. Confirmation separately transitions the
original prepared record to `confirming` before its first fresh verification;
concurrent or repeated pending requests observe that record without relaunch.
Changed or unavailable evidence leaves a blocked historical intent. Lost storage
acknowledgements are read back by the original identity, never converted into a
new reservation. A pending reservation after a process crash remains pending;
there is no automatic recovery launch.

Core persists only opaque identity/input/component/binding hashes, lifecycle
state, timestamps and constant failure codes. It stores no selected message IDs,
source references, manifest snapshots, content, embeddings, reason or actor name
in this receipt collection. Native previews are ephemeral. After preparation
storage or reopening reconciliation awaits, a final full Core source/index and
privacy fence runs before releasing a private preview. It creates no additional
temporary copy. Forgotten sources cannot be reopened from the historical receipt.

`GET` and confirmed replays return no preview and report `nativeState:
not_rechecked`; a historical confirmation never establishes current availability.
The composed native reads are not an atomic cross-service snapshot. The existing
native reader boundaries and capacity limits still apply.

## Browser recovery

The browser journals the immutable original UUID, selection, cutoff, binding and
transport phase before writing. Failure to retain the journal blocks the write.
An uncertain reply is reconciled with `GET` on that original UUID. An absent
receipt, or an earlier prepared state after an uncertain confirmation, does not
prove that the original request finished. Pending transport cannot create a new
identity or silently change its input. Reloading a known prepared receipt requires
an explicit matching preview reopen before confirmation is enabled again.
Complete native evidence with a different binding during reopening blocks the original receipt
without replacing its hashes. After acknowledging that outcome, the owner can
explicitly prepare a new identity. Transient unavailable reads retain the original
prepared state and do not establish an empty or unchanged source. A native HTTP
409 alone does not distinguish those cases. The owner can explicitly leave a
known prepared receipt unconfirmed and prepare another selection; its original
journal and Core receipt remain preserved. Pending or uncertain confirmation
cannot use that path or acquire a new identity.

The response always keeps `reviewOnly: true`, `authenticatedPerson: null`,
`semanticAcceptance: false`, `approvalBound: false`, `mailboxEffects: 0`,
`executionAllowed: false` and `cleanupStatus: blocked`. All four global native
acceptance gaps remain. This exact-evidence human receipt creates neither a
cleanup executor nor a permission and does not discharge the remaining semantic,
decision, preservation or mailbox-approval acceptance contracts.

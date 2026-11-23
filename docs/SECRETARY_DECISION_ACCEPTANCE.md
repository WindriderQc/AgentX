# Native acceptance of selected recorded decisions

The optional decision-reconciliation contract evaluates the recorded findings
and linked Core decisions in an exact selected review manifest. It uses the
[current human confirmation](SECRETARY_CONFIRMATION_CURRENT.md), including the
full selected native archive and Core BSON/index restoration. The original human
receipt remains immutable. LAN human access still authenticates no person.

`POST /api/secretary/history/manifest-confirmations/:requestId/decision-acceptance`
accepts the original retained `checks`, canonical UTC `before`, fresh
`observationId`, optional parent `expected` fingerprint and optional
`expectedCurrent` child fingerprint. The existing owner/family boundary applies;
no MCP tool or new permission exposes this observation. Responses are private,
uncached metadata with no source text, references or native preview.

Core reuses one current-confirmation composition per observation. Its final full
Core source/index/privacy fence follows all metadata awaits. A synchronous policy
then checks the entire selected graph, with no later asynchronous evidence read.
The observation writes no decision or confirmation and starts no mailbox action.

| Recorded item | Required decision |
| --- | --- |
| Action, deliverable or invoice | Explicit `resolved` or `dismissed` decision |
| Information | Dated, reasoned `retained`, `resolved` or `dismissed` decision |
| Existing linked souvenir | Current source and context bindings, no pending replacement |
| No linked souvenir | Allowed; no implicit obligation to create a memory note |

Resolution records the human decision about the item; it is not independent proof
that a task was completed or an invoice paid. Dismissal settles the recorded
proposal without inventing a completion. The history review surface allows an
invoice to be explicitly closed using the existing revision and reason controls.

Every recorded finding must have a matching, dated Core decision of the native
kind. Pending source-review intents, unmatched Core references, unresolved thread
questions, missing findings, stale or unavailable links, mailbox/cutoff blockers
and a changed original human binding hold the entire selected scope. An empty
finding inventory cannot pass vacuously. Missing native evidence returns an
unavailable response, never partial acceptance.

The contract is `agentx.history-decision-reconciliation-acceptance/v1`. Its
snapshot binds the child confirmation fingerprint and snapshot, selected-message
hashes, aggregate counts and sorted blocker codes. `accepted_scope` means every
message passes the stated recorded-decision policy. Only then does
`native_decision_reconciliation_unavailable` leave `nativeValidationGaps` for
this exact report. A blocked scope retains all four gaps. Metadata is bounded to
64 KiB for the snapshot and 128 KiB for the response.

## Optional private reconciliation v14

`retention_reconcile.py --native-decision-acceptance <original-human-UUID>`
requires `--native-review-restoration-checks` and implies the existing v11/v12
native observations. If `--native-manifest-confirmation` is also supplied, its
UUID must be identical before HTTP starts. Earlier modes retain their behavior.

The client validates two parent observations and their embedded current-human
confirmations against the independently verified v11/v12 graph. It reconstructs
the policy output locally, requires unchanged fingerprints and fresh matching
parent/child nonces, and never makes a separate `/current` request. The two
observations are the final HTTP calls; only existing local disposition and graph
fences follow. Requests have a 1,200-second timeout, bounded responses and no
automatic retry. Unknown, changed or unavailable human evidence yields no success
report. A current but decision-blocked selection produces a blocked v14 report.

V14 exits 2 even for accepted recorded decisions. Semantic comprehension,
independent physical preservation and mailbox-cleanup approval remain unaccepted.
`semanticAcceptance`, `approvalBound` and `executionAllowed` stay false,
`authenticatedPerson` remains null, `mailboxEffects` is zero and cleanup stays
blocked. No whole-corpus qualification, real campaign, deployment or instance
change follows from this contract.

The separate [selected preservation acceptance](SECRETARY_PRESERVATION_ACCEPTANCE.md)
embeds this decision result in a private v15 composition. It evaluates
preservation independently and retains the same decision policy and v14 meaning.

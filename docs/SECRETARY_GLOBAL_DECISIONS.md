# Global selected historical decision observations

`POST /api/secretary/history/decision-state/global` composes the existing native
recorded-finding and Core decision observations for one explicit selection.
It belongs to the existing private owner Secretary surface and returns
`agentx.history-global-decisions/v1`, with `Cache-Control: private, no-store`.
Pinned family devices and a family audience cannot use this capability.

Input contains only `sources` (1–20 exact Gmail references: `system`,
`messageId`, `threadId`, `sourceSha256`), a fresh `observationId` UUID and an
optional previous `expected` fingerprint. Every message appears once. Core
sorts the selection by message ID; no query, account, host, path, acceptance
flag or caller header can widen it.

Core first observes the whole selected membership through one bounded database
query, including primary and related references across source systems. The
shared observer retains the original single-message contract and its privacy
fences. The global selection is limited to 100 unique entries, 512 KiB per
record and 8 MiB aggregate after excluding context source bodies. Limits apply
inside Mongo before full records reach Node. A conflicting source binding or
capacity failure refuses before calling the native producer.

Two complete passes then read each selected recorded finding scope through its
existing native reader, server nonces and current decision checks. Each scope
must match the original Core membership pins; the second complete pass must
match the first. After **all** producer calls, the shared observer checks privacy
and rereads the complete selected set. An earlier member changing or being
erased during a later message's work cannot escape through a per-message fence.
No producer call or other asynchronous source read follows this final fence.

The snapshot retains the exact sorted source set and its canonical hash,
per-message Core pins, finding-scope fingerprints/snapshots and aggregate
coverage counts. Entry count is globally unique. Finding, unmatched-reference
and whole-thread question counts are sums of per-message observations: shared
thread questions may therefore occur more than once. Missing decisions,
unmatched entries, open retained actions and unresolved questions stay held.
The complete snapshot is bounded to 1 MiB, also checked while accumulating the
first pass. Failure returns no partial successful observation.

The optional reconciliation flag `--native-global-decisions` selects v8 and
implies the existing v4 finding/message/decision checks. It composes v5
restoration, v6 linked-souvenir and v7 live-mailbox options. The Python client
requires exact canonical equality with every already-verified finding scope;
extra or omitted sources, stale pins and bool/float substitutions for integer
metadata refuse. Two complete global HTTP observations must agree, each bounded
to 2 MiB and 240 seconds without automatic retry. Core and local archive pins
are rechecked again after all native probes, before the immutable private report.
Stdout contains only counts. Held evidence yields exit 2; failed or changing
evidence writes no success report. Existing v1–v7 modes remain unchanged.

This is a bounded observation across Core and the native producer, not an
atomic cross-document/archive transaction, authenticated person, semantic
acceptance, downstream settlement, complete archive preservation/restoration
acceptance or manifest-to-mailbox approval. All four global native gaps remain,
with `executionAllowed: false` and `cleanupStatus: blocked`. No decision,
commitment, memory or mailbox state is changed. Isolated synthetic tests do not
qualify a real corpus; large real observations retain their separate authority
and heavy-work queue requirements.

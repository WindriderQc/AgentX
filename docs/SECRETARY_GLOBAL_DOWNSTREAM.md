# Global selected linked-souvenir observations

`POST /api/secretary/history/decision-state/downstream/global` belongs to the
existing private owner Secretary surface and returns
`agentx.history-global-downstream/v1`, with `Cache-Control: private, no-store`.
Input contains only 1–20 exact `sources`, a fresh `observationId` UUID and an
optional previous `expected` fingerprint, using the existing global source
validator. Every message appears once; Core sorts the selection by message ID.
No account, query, host, path, approval or caller header can widen the selection.

Per-message downstream observations remain useful for one message. Collecting
them sequentially cannot establish a current whole selection: a note linked to
an earlier message can change while a later message is being checked. The
global contract fences both the selected Core membership and its linked notes.

Core first observes every selected entry and its existing linked souvenir in
bounded joined database queries, with the existing privacy checks between
reads. Note availability and metadata use the same owner memory-space boundary,
expiry/current-state filter and fingerprint projection as `souvenirEvidence`.
Embedding vectors and context source bodies are excluded. No note is created,
activated, corrected, indexed or restored by observation.

Two complete passes then invoke the existing per-message downstream producer.
Every first-pass finding/Core scope and note binding must match the initial
joined graph; every second-pass complete snapshot must match the first. After
all native producer and memory calls, Core repeats the entire joined selection.
Its last bounded aggregate reads entries and linked notes together, after the
privacy awaits. Late earlier-entry or earlier-note changes refuse. No external
or asynchronous evidence read follows that final aggregate.

The complete selection is limited to 100 unique Core entries, 512 KiB per entry
after excluding context bodies and 8 MiB aggregate entry data. Selected active
note records exclude vectors, are individually limited to 512 KiB inside Mongo,
and consume an 8 MiB aggregate evidence budget; repeated joined copies of a
shared note consume that budget too. An oversized or inconsistent shared note
refuses before producer work. Missing, pending, expired or invalidated notes
stay unavailable; source/context mismatches and unfinished replacements stay
held. Unselected note records are not inspected.

The snapshot retains the exact sorted source set, canonical source-set hash,
complete per-message snapshots/fingerprints and aggregate coverage. Entry and
available-note counts are unique across messages. Held-message counts are per
message; nested finding/question counts keep their per-message meaning. The
snapshot is bounded to 1 MiB, including while the first pass accumulates.

`retention_reconcile.py --native-global-downstream` selects private report v10
and implies the existing native downstream/finding/message/decision checks.
It composes the other optional v5–v9 observations. The client independently
derives the exact expected global snapshot from its already verified v6
observations, then requires two complete native global observations to match.
Each HTTP response is bounded to 2 MiB and 240 seconds without automatic retry.
The existing final Core/archive fences run after every optional probe, before
the immutable private report. Standard output contains counts only; held
findings or notes yield exit 2 and failed evidence writes no success report.

This is a bounded observation, not an atomic cross-collection/archive snapshot,
semantic acceptance, authenticated person, recall-index qualification, Core
state restoration, complete downstream disposition, global preservation
acceptance or mailbox approval. All four global native gaps remain, with
`executionAllowed: false` and `cleanupStatus: blocked`. Existing single-message
contracts and v1–v9 modes keep their meanings. Synthetic tests do not qualify a
real archive; real campaigns retain their own authorization and Core queue.

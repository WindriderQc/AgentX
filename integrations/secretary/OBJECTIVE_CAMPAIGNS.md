# Bounded objective continuations

`objective_campaign.cjs step --config "$PRIVATE_CAMPAIGN"` advances one durable
control step over Core's existing heavy-work queue. Run it after a measured
pilot has established practical page and time bounds. It creates no cron,
parallel queue, new model client or confirmed memory. A future reservation
remains in Core; an authorized caller can repeat `step` or use the durable
`watch` controller below.

Private configuration names `id`, `actor`, `core`, `objectiveFile`, optional
`archiveRoot`, explicit `hosts`, the session/issue `source`, `startBefore`,
Core placement `when` (`asap` or `tonight`), and positive `maxPages`,
`maxSeconds`, `estimatedMinutes` and `publishBudget`. No concrete model or
load/context options belong in it. A configuration change uses a new campaign
identity while preserving the objective's existing page receipts.
Optional `priorityFile` names a private JSON array of `gmail:<native-id>` or
`outlook-export:<sha256>` keys. It changes execution order only, without adding
instructions to the model or changing source/page/goal reading identities.

Explicit `publicationMode: "review-only"` continues the native source reading
campaign while retaining proposals only in its durable objective receipts.
The controller never calls the publisher in this mode, including completed
chunks, a publication-pending checkpoint, complete text, exhausted source gaps
or graceful deadline/signal drain. Proposals do not block further reading.
`textualCoverage` counts actual page/verified-equivalence progress separately
from `proposalReview`; semantic acceptance remains `not-established` and no
user confirmation or Core personal-history write is performed by the
controller. Text completion leaves all propositions available for a separate
source review and explicitly selected native import.

Omitted mode preserves the existing candidate publication behavior; explicit
`"publish-candidates"` names that behavior. The mode enters the immutable
campaign configuration hash, so changing it requires a new campaign identity.
Existing `reviewBeforePublication: true` pilot gates still stop after their
bounded native release. Queue planning/admission, model routing and source
reading receipts remain the same in both modes.

Review-only campaigns can explicitly set
`onInvalidOutput: "retain-and-continue"`. A certainly received terminal response
which fails output validation then becomes an immutable
`page-dispositions/<pageId>.json` gap. Its exact objective/source/page identity,
text hash and range, native request identity, validation failure and retained
HTTP/model/result hashes remain verifiable. The validator is unchanged; no
quote or result is edited, published or retried. Previously received cached
results can receive this disposition without another inference.

This policy changes the immutable campaign configuration and requires a new
campaign identity. It changes neither the frozen objective nor the model
request. Unknown transport/status, missing or corrupt receipts, source errors
and manifest/identity failures still stop for reconciliation. The page budget
counts newly accepted pages, newly rejected pages and new exact-copy reports
together, also within each source. A rejected page is
excluded from accepted reviews, findings and text coverage, and remains visible
in `rejectedPages`, `sourcesWithRejectedPages` and source gaps. It is removed
only from `pendingPagesKnown` (work still eligible to attempt); when all other
pages have been visited, coverage stays incomplete and the controller stops in
`needs-source-review` instead of creating empty chunks.

The same explicit policy can defer an exact copy of a wholly rejected unit.
Separate `rejected-copy-reports` preserve that target as an uncovered gap;
`deferredRejectedCopyPages` and `sourcesWithDeferredRejectedCopies` never add
accepted reads, equivalences, rejected outputs or findings. RFC/context, complete
exact text, representation scope and page ranges must match; every canonical
rejection and retained response is revalidated. An existing target attempt keeps
its native recovery path. Partial/mixed canonical units and text variants do not
qualify. Conflicting or altered reports block. See the
[objective contract](OBJECTIVE_REVIEW.md) for these conservative proof limits.

The controller records its native queue key before submission. It reconciles
the same key/ID on a lost response, respects Core's placement, and obtains the
operator dispatch only inside its reservation. Each chunk runs in one retained
systemd user service named from that queue ID. A missing unit after a saved
launch intent is uncertain and never authorizes a replacement. Repeated steps
observe the existing process; they do not spawn another worker.

An exact terminal worker status, successful native process termination and
empty runtime coordination precede the operator release receipt. Core retains
final release validation. An uncertain inference, missing status or active
runtime prevents release. Known extraction/validation failure retains its
source checkpoint for repair rather than silently skipping evidence.

In candidate publication mode, after a chunk is natively completed/released,
the controller publishes its candidates through the existing Core importer
before preparing the next chunk.
Publication keeps exact native import identities and hashes. Repeated writes
enrich the same candidate using Core's context revision, preserving owner
overrides and decisions. A lost mutation with no matching Core receipt blocks
replacement. Large groups of equivalent copies retain their full native proof
manifest while Core stores bounded representative copies and explicit
`timeline.metadata.proofLimits` counters; no distinct model evidence is cut.

Checkpoints under `objective-reviews/<id>/<version>/campaigns/<campaign>/`
contain native identities, exact request/launch/release receipts and progress,
not an alternative planning authority. `text-scope-complete` requires all
target text to be read or verified equivalent. Candidate publication mode also
requires current candidates to reconcile in Core; review-only retains them in
the native objective receipts for separate review. Remaining visual/OCR/context gaps, semantic acceptance and
human confirmation remain separate. Do not mark an entire life reconstruction
complete merely because one bounded chunk ended.

If every target has been materialized and no text page remains but coverage is
still incomplete (for example an unreadable MIME representation), the controller
publishes acquired candidates only in candidate publication mode, then stops
for source review. Review-only retains them without invoking publication. It never keeps
creating empty chunks or counts missing readable text as a semantic review.

## Durable progression

```sh
node integrations/secretary/objective_campaign.cjs watch \
  --config "$PRIVATE_CAMPAIGN" --until "$EXPLICIT_ADMISSION_DEADLINE" \
  --poll-seconds 30
```

`watch` repeats the same native step every 15–60 seconds, including waiting for
other work to release its resources, beginning inside Core's window, observing
the retained worker, releasing each chunk and applying the configured proposal
disposition before the next. It terminates only after text coverage and the
configured proposal disposition, a known failure
or uncertainty requiring review, or an explicit admission deadline. The
deadline must be no later than the campaign's `startBefore`.

At the deadline, or SIGTERM/SIGINT, it cancels an unstarted request/reservation
through Core under its original identity. Already admitted work remains bounded
by its worker budgets and native queue window; the controller observes its
termination, release and configured proposal disposition before stopping. A lost cancellation reply
reconciles the same request, never a replacement. No new chunk starts while
draining. A failure leaves an exact `watch-status.json` and all native fences
intact; no automatic restart conceals or retries an uncertain result.

Run this controller in one retained user service for operational durability.
Use a stable unit identity, `Restart=no`, and a stop timeout longer than the
bounded worker plus release/publication allowance. Observe that same unit after
a lost launch response. A live `watcher.lock` prevents two observers; only a
dead observer lock can be released without touching worker/inference fences.
The explicit deadline and graceful drain are independent of the Coding task's
human confirmation or goal completion. Private watch checkpoints and receipts
remain outside public Git.

## Receiving a bounded operator pilot

Optional `existingQueueId` plus `expectedQueueIntentHash` adopts a previously
reviewed operator request instead of submitting another identity. Core's
immutable intent, operator executor kind and declared hosts must match before
the controller records adoption. The existing reservation, dispatch and planned
terminal receipt remain authoritative; adoption never grants early execution.

`maxPagesPerSource` forwards a pilot's explicit per-source bound to the native
worker. `reviewBeforePublication: true` stops after the admitted chunk has
terminated and Core has accepted its release receipt, in
`awaiting-output-review`. The watcher then exits cleanly without publishing or
creating another chunk. The authorized caller audits the exact outputs, uses
the native publisher with any necessary date adjudications, and chooses the
measured bounds for a separate continuing campaign. This output gate creates
no owner confirmation and requests no additional human campaign approval.

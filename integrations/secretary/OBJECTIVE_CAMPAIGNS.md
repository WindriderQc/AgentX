# Bounded objective continuations

`objective_campaign.cjs step --config "$PRIVATE_CAMPAIGN"` advances one durable
control step over Core's existing heavy-work queue. Run it after a measured
pilot has established practical page and time bounds. It creates no cron,
parallel queue, new model client or confirmed memory. A future reservation
remains in Core; the operator or active authorized task calls `step` again.

Private configuration names `id`, `actor`, `core`, `objectiveFile`, optional
`archiveRoot`, explicit `hosts`, the session/issue `source`, `startBefore`,
Core placement `when` (`asap` or `tonight`), and positive `maxPages`,
`maxSeconds`, `estimatedMinutes` and `publishBudget`. No concrete model or
load/context options belong in it. A configuration change uses a new campaign
identity while preserving the objective's existing page receipts.

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

After a chunk is natively completed/released, the controller publishes its
candidates through the existing Core importer before preparing the next chunk.
Publication keeps exact native import identities and hashes. Repeated writes
enrich the same candidate using Core's context revision, preserving owner
overrides and decisions. A lost mutation with no matching Core receipt blocks
replacement. Large groups of equivalent copies retain their full native proof
manifest while Core stores bounded representative copies and explicit
`timeline.metadata.proofLimits` counters; no distinct model evidence is cut.

Checkpoints under `objective-reviews/<id>/<version>/campaigns/<campaign>/`
contain native identities, exact request/launch/release receipts and progress,
not an alternative planning authority. `text-scope-complete` requires all
target text to be read or verified equivalent and all current candidates to
reconcile in Core. Remaining visual/OCR/context gaps, semantic acceptance and
human confirmation remain separate. Do not mark an entire life reconstruction
complete merely because one bounded chunk ended.

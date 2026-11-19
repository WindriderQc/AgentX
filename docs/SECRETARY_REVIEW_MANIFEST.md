# Native selected review evidence manifest

`POST /api/secretary/history/review-manifest` composes the existing native
decision, linked-souvenir, review-graph restoration and live-mailbox scopes as
one `agentx.history-review-manifest/v1` snapshot. The existing private owner
Secretary surface owns this route; responses use `Cache-Control: private,
no-store`. A family audience or pinned family device cannot use it.

Input contains only 1–20 exact retained v3 restoration `checks`, a canonical
UTC millisecond `before` cutoff, a fresh `observationId` UUID and optional
previous `expected` fingerprint. Sources derive from the checks and are sorted
by message ID. No account, query, host, path, supplied proof, approval or effect
can widen this selection. Preparing the manifest creates no preservation receipt
and cannot upgrade an earlier byte-only receipt.

Core observes the complete selected Core/note graph, then invokes its existing
global decision, global downstream and selected review-restoration services,
and each selected live-mailbox service. Each child keeps its native producer,
nonces, source/privacy controls and limits. Live provider reads remain read-only;
archive restoration uses only its existing owned temporary custody mechanism.

Every component must describe the same exact selection. Downstream finding
snapshots match the global decisions, mailbox Core pins match those findings,
and both restored review graphs match the current finding evidence/review hashes.
All native account-selector hashes agree; the selector does not authenticate
a human or establish a provider account identity. Missing, extra, rehashed but
inconsistent or stale components refuse; partial proof has no fallback.

After **all** archive, disk-restoration and provider calls, Core rechecks the
entire joined Core/note graph with the existing privacy checks. Its last bounded
aggregate reads both collections after those awaits. A note edited during later
restoration or mailbox work cannot escape through an earlier component's fence.
No external or asynchronous evidence read follows this final query.

The canonical snapshot retains sorted references and source/check hashes, the
four complete component proofs/fingerprints and per-message coverage. Native
finding, souvenir and mailbox blockers stay visible. A present message at or
after the cutoff has `live_message_outside_cutoff`; equality is not older. A
missing source stays held; provider authorization/unavailability errors refuse.
Counts distinguish selected messages, unique entries, available notes, live
presence and messages with evidence blockers. Every cleanup candidate remains
false. All four global native acceptance gaps remain blockers even when the
bounded observations agree. The complete snapshot is limited to 1 MiB.

This is a stateless observation. Its fingerprint addresses its exact canonical
contents; it is not a retained Core approval, executor intent or permission.
It is not an atomic provider/archive/database snapshot, authenticated person,
semantic acceptance, recall-index qualification, Core-state restoration,
complete preservation acceptance or native mailbox approval. Responses retain
`reviewOnly: true`, `mailboxEffects: 0`, `approvalBound: false`,
`executionAllowed: false` and `cleanupStatus: blocked`.

`retention_reconcile.py --native-review-manifest` selects private report v11 and
requires `--native-review-restoration-checks` before any HTTP. It implies the
existing native decision, downstream and mailbox observations. Its client derives
the exact expected manifest from the already verified components, then requires
two fresh agreeing Core observations. Each HTTP response is bounded to 2 MiB
and 960 seconds, without retry. Timezone-free or sub-millisecond cutoffs refuse
instead of silently changing the selection.

The manifest calls follow the earlier final Core/archive checks. After the final
HTTP result, the client performs only local archive-disposition and bounded local
review-graph checks using the already observed Core rows. Changes write no success
report. Output remains private and immutable; stdout contains counts only.
V11 returns exit 2 because native acceptance gaps remain. Older observation modes
retain their meanings. No real campaign, provider/model action, deployment,
permission or instance change follows from isolated tests or code installation;
real campaigns retain their own authority and Core queue requirements.

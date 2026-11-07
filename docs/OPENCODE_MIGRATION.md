# Preparing a DSH to OpenCode migration

The migration preserves native execution histories, worker conversations and
independent human continuations. Changing `AGENTX_CODING_HARNESS` alone does not
provide that parity. Preparation tools do not select an executor, deploy a Web
server, migrate a transcript or invoke a live model. Delivery is tracked in
[#1310](https://github.com/WindriderQc/AgentX/issues/1310).

Core retains request identity, executor binding, admission, budgets, stop and
reconciliation, task state and publication. See the
[multi-harness contract](CODING_TEAM_ARCHITECTURE.md) and
[shared agent capabilities](SHARED_AGENT_CAPABILITIES.md).

## Retain and verify native histories

Preserve Studio's complete native state, attachments, profile manifests and
lockfiles, continuation receipts and repositories. Preserve the worker homes,
all history generations (including compressed files), original repositories,
rejected stashes and native execution receipts. Keep the reviewed runtime and
legacy-session compatibility installer available. Dependencies can be rebuilt
from the retained locks; they are excluded explicitly from the inventory.

Capture an inventory outside each source root, copy that root to private
storage, then verify the copy and the source against the same manifest:

```bash
python3 integrations/coding/coding_history_inventory.py capture \
  --root /private/studio-state --manifest /private/evidence/studio.json
python3 integrations/coding/coding_history_inventory.py verify \
  --root /private/backup/studio-state --manifest /private/evidence/studio.json
python3 integrations/coding/coding_history_inventory.py verify \
  --root /private/studio-state --manifest /private/evidence/studio.json
```

The manifest records file hashes, bytes, symlink targets, empty directories and
exclusions. It contains private names, never transcript content. Symlinks are
not followed; a matching manifest does not preserve their external targets.
Retain those dependencies separately. Special files and changing files refuse
capture. Two matching scans detect observed change, not a transactional snapshot
of an active writer: quiesce writers under their native owner for the final
backup. Never overwrite a manifest to conceal a mismatch. A copied history tree
does not back up worker repositories or receipts outside that tree.

Use the reviewed native reader to check all discoverable Studio and worker
histories, preferably on the preserved copy with their original directory
layout. No Session agent or model provider is created:

```bash
node integrations/coding/dsh_history_check.mjs \
  --runtime-root /reviewed/dsh \
  --studio-sessions /private/studio-state/sessions \
  --workers-root /private/worker-workspaces
```

The checker uses Studio's compressed backend and the workers' plaintext
backend. A compression mismatch is a reader configuration error, not evidence
of corrupted history. Failed roots or sessions make the command fail. Compare
inventories before and after reading. Retain native DSH access until an archive
reader with equivalent history and attachment coverage is qualified. A summary,
Markdown transcript or renamed OpenCode session is not a native migration.

## Qualify the exact OpenCode runtime

Install the instance's reviewed lock into a separate versioned runtime; do not
update the installed runtime in place. Run this CPU-only fixture on an isolated
development machine, with an explicit binary and version:

```bash
python3 integrations/coding/opencode_migration_smoke.py \
  --binary /reviewed/opencode/node_modules/.bin/opencode \
  --expected-version 1.19.3 --output /private/evidence/opencode-smoke.json
```

The fixture creates a disposable home, XDG roots, Git repository and loopback
synthetic provider. It does not inherit provider credentials or runtime config.
Its provider accepts only `agentx-primary` and returns fixed tool calls; no live
model or Core service participates. It verifies:

- Authenticated native session reads, with unauthenticated access refused.
- Real read, edit and shell test tools, persisted arguments/results and an
  independent behavior test.
- Worker discovery and a completed tool visible while the provider is held;
  observing the active worker makes no provider request.
- History across process restart, a native fork without inference, explicit
  CLI continuation and the attached-task CLI invocation.
- Native export/import into a separate state root, preserving every exported
  message and part, including tool identities and results, without inference.

A successful receipt still says `cutoverReady: false`. A native fork shares the
source directory. Native import binds its session header to the import command's
working directory; historical message/tool paths remain recorded. Neither
command creates an independent repository. The fixture uses the native API, not assumptions
from newer documentation. It does not test the browser, the host controller,
Bubblewrap, Core's gateway or real model competence.

## Core worker conversations and independent human copies

The OpenCode runner records one host-owned binding per invocation beneath
`coding-run-requests/<requestId>.sessions/`. The binding connects the original
Core task and request to the session id emitted by that invocation's native
JSONL stdout, its private home and repository. It is outside worker-writable
mounts; discovery never guesses the latest session in a shared home. DSH's
runner, histories and Studio bridge keep their existing behavior.

Pipeline's worker monitor opens **Voir la conversation OpenCode** for an
OpenCode executor. It reads actual native messages and parts, including tool
arguments, output and errors. This is a Core viewer over native history, not a
writable observer session imported into the human runtime. A committed-WAL
SQLite read uses read-only/query-only mode and a consistent transaction. The
qualified schema is OpenCode 1.19.3. Complete snapshots are limited to 10,000
messages and 16 MiB of stored JSON; pages are limited to 20 messages/2 MiB.
Unsupported schemas, oversized messages and changed page revisions refuse
explicitly rather than truncate evidence. Observation never starts a runtime or
inference. Local child exit does not establish Core model/resource release.

The existing dispatch bridge supplies exact-executor routes:

```text
GET  /api/runtime-bridges/coding-dispatch/runs/:requestId/sessions
GET  /api/runtime-bridges/coding-dispatch/runs/:requestId/sessions/:invocationId
POST /api/runtime-bridges/coding-dispatch/runs/:requestId/sessions/:invocationId/handoff
```

Reads require `pipelineId` and the original `executorId`; a page may add
`offset` and its `revision`. Handoff requires the same identities, exact source
`revision`, a stable `handoffRequestId` UUID and `confirm: true`. No alternate
executor or accepted worker request is launched. The host validates its original
native receipt before returning history. Responses use `Cache-Control: no-store`.

Independent copies are opt-in through these private host settings:

```text
AGENTX_OPENCODE_ROOT=/reviewed/opencode
AGENTX_OPENCODE_ENTRY=node_modules/.bin/opencode
AGENTX_OPENCODE_HUMAN_HOME=/private/opencode-human
AGENTX_OPENCODE_HANDOFF_ROOT=/private/opencode-handoffs
AGENTX_OPENCODE_HUMAN_URL=https://opencode.example
```

The human server uses that home and its `.config`, `.local/share`, `.cache` and
`.local/state` directories as its XDG roots. Configure its own approved Core
gateway provider with `agentx-primary`, authentication and context before using
it. No worker relay configuration, provider secret, MCP setup or Core execution
grant is copied. The adapter neither installs nor starts that server. Keep its
private HTTPS origin distinct from worker homes; loopback HTTP is supported for
isolated qualification. No model or host pin changes are implied.

**Reprendre dans une copie indépendante** is available after the original
invocation exits. In-flight tool parts, reverted sessions, incompatible native
identifier formats and changed source revisions refuse. It uses the existing
DSH Git-copy primitive, verifies before/after/copy file fingerprints, preserves
dirty files, untracked files, deletions and `refs/stash`, removes remotes,
disables hooks and avoids shared writable objects. Ignored dependencies are
excluded; unsupported entries or a changing repository refuse the copy.
Files represent copy time, not the historical message boundary. The bound is
128 MiB per file and 512 MiB total source bytes.

The native import receives a new human session plus collision-free message and
part ids, retaining their monotonic order, payloads and timestamps. A native
user notice records provenance and the independent current directory. Historical
arguments and paths remain unchanged. Permissions come from the human profile.
The human runtime can continue normally from its own directory; the original
worker, native history, task state, budget and publication stay unchanged.

A private receipt is persisted before effects. Repeating the same request and
source revision returns the same copy. After a lost import response, recovery
only reads the existing native import and verifies its complete message hash;
it does not copy or import again. An incomplete or conflicting intent remains
blocked on its original receipt. Preserve handoff state and human home across
configuration moves and restarts. Never delete a pending receipt to retry under
another identity. The browser retains the handoff UUID across reloads.

The native CPU fixture exercises the real sandbox, relay, CLI, host transport,
SQLite reader, independent repository and native human tool execution. Its
optional browser stage exercises Core's actual routes and native host control
with synthetic request receipts, including a lost successful response and a
browser reload at desktop/narrow widths:

```bash
python3 integrations/coding/opencode_worker_bridge_smoke.py \
  --runtime-root /reviewed/opencode \
  --node-root /reviewed/node \
  --playwright-module /test-tools/node_modules/playwright \
  --chromium /test-tools/chromium/chrome \
  --output /private/evidence/opencode-worker-bridge.json
```

No installed Core or real model participates. A native human file write must
exist only in its independent copy, and source files/history must stay unchanged.
This does not qualify installed gateway admission/release, report evidence,
uncertain model recovery, the human OpenCode Web application or real-device
acceptance. `cutoverReady` remains false until those separate gates are received.

## Replacement gates

| Gate | Evidence required before retiring the incumbent |
| --- | --- |
| Historical access | Verified final backup, matching inventory and native-reader counts; archived attachments and human continuations remain usable. |
| Worker visibility | A stable Core request/executor/native-session/workspace binding; native messages and tool results update while the actual worker writes, through reconnect and process restart. Observation must never invoke inference or provide a writable worker home to the human runtime. |
| Progress and budgets | OpenCode events drive the existing sanitized stages and test outcomes. Model requests, output limits, inactivity and useful-progress accounting retain the runner's policies. |
| Reports | Research/save-pass evidence has an OpenCode reader with exact call/result and source bindings, or report capability stays on its qualified executor. |
| Human continuation | One durable handoff identity creates a separate repository and session with retained provenance, dirty files, deletions and rejected stash. No shared writable Git objects, hooks, remotes or worker credentials. Lost replies reconcile the original receipt. |
| Stop and recovery | Native interruption, server/controller restart and lost model/launch/result responses retain their exact identities and Core termination/release receipts. No replacement run while the original is uncertain. |
| Human interface | Local authenticated Web entry, wide/narrow layouts, attachment and file views, live workers and continuation controls tested in a real browser. |
| Installed acceptance | Queue representative tasks through the real host controller, sandbox and Core gateway; receive native admission and release. Compare fixes, feedback continuation and interruption recovery. |
| Rollback | Drain active work, preserve post-switch histories and restore only the reviewed executor/entry settings under the native maintenance owner. Never restore an old whole state tree over newer work. |

The OpenCode progress and report adapter reads the exact host-bound invocation
through the same read-only native SQLite reader. It projects live tool starts,
completed results, test exits and output limits into the runner's existing
sanitized stages. Unchanged native records do not refresh activity or useful-work
timers. Model-call accounting stays on the relay; no history read bills a call.
Missing exit evidence and interrupted tests remain unknown, never successful.

Report research is selected by original request, workspace, newly created
invocation and step output. A drained native session supplies complete paired
tool inputs/results with native message, part and call identities; assistant
text and reasoning are excluded. Earlier logical sessions, ambiguous invocations,
changed identities, pending tools and oversized capsules refuse. The save pass
retains the existing Core settlement, writer reserve and durable one-pass fence.
Read-only report tools may read the separate `/workspace` mount and write their
private output; the source mount and Git metadata remain read-only in Bubblewrap.
Bounded source editing preserves the harness's advertised read-path argument.

The [parity fixture](../integrations/coding/opencode_parity_smoke.py) exercises
native read-only research, evidence-funded saving, scoped source-pair editing
and test progress with a synthetic provider and explicitly synthetic Core
authority. It makes no live model call. Installed report/autonomy and interruption
acceptance still require the queue and original native authority.

DSH keeps its existing progress reader and
[native Studio bridge](../integrations/dsh/coding-team/src/bridge.mjs).
Both observers project native history without another task or transcript owner.

Use separate human and worker state roots. Importing a worker's writable
database or sharing its home would defeat isolation. Native session forks alone
do not satisfy the human continuation gate. Retain the original native format;
any translated history must identify its source and disclose unavailable
constructs rather than manufacture successful calls or completed work.

## Cutover procedure

1. Finish the gates above, recording exact revisions, runtime versions, manifest
   hashes and native receipts in private instance evidence.
2. Obtain authorization for the concrete cutover and its queued live checks.
   Preparation does not grant model work or permission to retire the incumbent.
3. Under the native maintenance owner, stop new dispatch and let active work
   settle. Reconcile uncertain requests on their original executor. Take and
   verify the final quiescent backup.
4. Enable only the qualified profiles on the candidate executor. Keep retained
   DSH access and the rollback installation. Route only new work to OpenCode;
   never relabel an existing accepted request or reuse its identity.
5. Receive installed worker, browser, continuation and gateway checks. Verify
   the existing model/context and pin contracts. Add no concrete model name to
   a client configuration.
6. Retire DSH execution only after acceptance. Remove its runtime only when its
   archive reader and rollback no longer depend on it. Keep all retained source
   histories and private migration evidence.

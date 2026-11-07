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

A successful receipt still says `cutoverReady: false`. Native fork and import
preserve source directory references; they do not create an independent working
repository. The fixture uses the installed runtime's native API, not assumptions
from newer documentation. It does not test the browser, the host controller,
Bubblewrap, Core's gateway or real model competence.

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

The current DSH-specific adapters are
[`coding_progress.session_logs`](../integrations/coding/coding_progress.py),
[`coding_report_save`](../integrations/coding/coding_report_save.py) and the
[native Studio bridge](../integrations/dsh/coding-team/src/bridge.mjs).
Pipeline's existing host/status display is useful, but does not replace the
native conversation bridge. A future OpenCode observer is a projection of its
native history, not another task or transcript authority.

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

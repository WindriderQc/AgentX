# Native coding sessions in DSH Studio

This optional bundle connects the coding worker's native DSH **0.2.0-rc.2**
execution histories to Studio's existing conversations. It replaces the embedded
Pipeline panel. **Sessions du coding team** opens the actual native transcript,
including messages and tool calls, and updates it from the worker log every two
seconds. It does not stream tokens that the worker has not persisted yet.

The observation is read-only. **Reprendre dans une copie** creates a durable
native DSH fork with the recorded history and a separate repository copy.
The human can then use Studio's normal conversation, files and tools. Opening
or copying a session never requests inference. A later human prompt uses the
Studio profile's own model selection, admission and permissions; expired worker
relay credentials and sandbox configuration are not installed into Studio.

Core remains the owner of tasks, dispatch, budgets, review and deployment.
A human continuation does not stop the original worker, approve its task or
publish its changes. Pipeline remains available through a separate link.
Missing worker logs are reported as missing history; a task status cannot
reconstruct an execution that was not retained.

## Private instance configuration

Install only in the private Web profile, preserving its existing bundles and
lockfiles. Supply these environment values to its existing service:

```bash
AGENTX_CODING_WORKSPACES=/private/coding-workspaces
AGENTX_DSH_TEAM_STATE=/private/studio-team-state
```

The first root contains the existing `task-NNNN` repositories and sibling
`.home-task-NNNN/.dsh/progress-sessions` histories. The native JSONL reader opens
these logs read-only, including while the original writer holds its lock. Never
remove its lock, mount the worker's writable home into Studio, or reuse a worker
execution request to launch a human continuation. The Studio process needs read
access to these directories. A sandboxed Studio must receive corresponding
read-only source mounts and a separate writable continuation root.

The second root contains private continuation receipts, independent Git clones
and empty observation directories. It defaults to `$DSH_HOME/agentx-coding-team`.
Keep it outside public Git. A stable request UUID reconciles a lost successful
response to the same continuation. An incomplete receipt blocks replacement:
inspect that receipt and its native session before recovering it. Do not delete
it to retry under another identity.

Observation sessions are reconstructed from their original logs after a Studio
restart; they are not a second durable task/transcript store. Live copied events
retain source payloads and translated references; their display arrival times
can differ from source times. Original timestamps remain in the source log.
Unexpected history rewrites or lifecycle seed markers stop synchronization with
an explicit error. Restart the bridge to reload a new source lifecycle.

Continuation copies retain tracked and nonignored untracked files, deletions,
Git objects and the rejected candidate in `refs/stash`, when present. Ignored
files such as dependencies are excluded. Git remotes are removed, hooks are
disabled and writable objects are not hardlinked. External or absolute symlinks
refuse the copy. The files reflect the repository at copy time, which may differ
from an older conversation's event boundary; an active worker can still change
its original directory. The continuation receipt records its source history
hash and any non-file paths omitted from the copy. Install dependencies and
inspect the stash deliberately before continuing a rejected candidate.

## Package and install

Build into a new private directory outside this repository:

```bash
node integrations/dsh/coding-team/scripts/package.mjs \
  --core-url https://agentx.example --output /private/artifacts/dsh-team
npm pack /private/artifacts/dsh-team --ignore-scripts --pack-destination /private/artifacts
DSH_HOME=/private/studio-home /selected/dsh/node_modules/.bin/dsh plugin --profile web add \
  /private/artifacts/agentx-dsh-coding-team-0.3.0.tgz
```

Keep the generated instance URL and tarball outside public Git. DSH peers come
from the selected runtime; disable peer auto-install. Keep native authentication
and the existing Studio model/context contract. Stage in a disposable profile
before installation. Retain the installed profile snapshot for rollback.

## Verification

```bash
npm test --prefix integrations/dsh/coding-team
node integrations/dsh/coding-team/scripts/smoke.mjs \
  --runtime-root /selected/dsh \
  --playwright-module /test-tools/node_modules/playwright/index.mjs \
  --chromium /test-tools/chromium/chrome
```

CPU checks cover packaging, containment and independent dirty repository copies.
The native smoke boots the packed bundle in an authenticated disposable Studio,
opens a native conversation at desktop/mobile widths, observes an appended event
while the source writer remains active, creates a human continuation and checks
that editing its copy leaves the original unchanged. Observation and handoff make no inference requests. A synthetic local provider
then returns a native file-tool call and a reply to qualify continuation; the
resulting file exists only in the human copy. These checks use no live model
and do not qualify autonomous worker output.
See [Studio setup](../../../docs/DSH_RESUMPTION.md) for native admission.

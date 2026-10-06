# Coding verification

This optional OpenClaw plugin gives explicitly configured workers
`agentx_coding_verify`, with no command or path arguments. The guarded dispatcher
prepares a private operator grant for the exact Core task lease, attempt and
session. The helper executes only the reviewed verification profile in Bubblewrap:
read-only task repository, disposable temporary directory, no network, home or
instance mounts. Calls, output size and deadlines are bounded. A failed test
returns its real receipt so the worker can correct the scoped patch in its turn.
Final dispatcher verification remains an independent acceptance gate.

Configure `helperPath` to the deployed
`integrations/coding/coding_worker_verification.py`, `agentIds` to the worker ids,
and optionally `grantRoot` to a private directory outside every worker workspace.
Load the plugin at Gateway startup and explicitly allow the optional tool in each
worker's tool policy. `agentx.coding-verification.status` is a read-only Gateway RPC
used before claiming a task; an absent tool, helper or file hook refuses execution.

The file hook permits `read` only on declared authority/scope files and canonical
repository instructions, and `write`/`edit` only on exact task scope entries plus
the assigned feedback artifact. Other tools, other tasks, symlinks and ignored
dependencies are refused. This uses the existing Gateway worker adapter.

Enable `executionProfiles.<id>.taskWorktrees: true` and
`verificationProfiles.<id>.workerVerificationCalls` (1–5) in reviewed dispatcher
configuration. Each task uses `tasks/<pipelineId>` next to the seed checkout.
Pre-claim retries reuse only a clean exact-base worktree; repair attempts require
their original task/profile receipt and preserve their original base and patch.
Dependencies are copied into each worktree. Accepted-result promotion reads that
recorded worktree; it keeps the existing human acceptance, review and merge gates.

Run `npm test` here and the Python coding integration suites from the repository
root. Runtime grants, task patches and verification receipts stay outside Git.

# Native coding team

**DSH Studio integration is deferred.** Its
launcher reserves the inference host for the whole web-server lifetime. Keep
the code and private workspaces, but do not enable permanent Studio startup.
See [the decision, preserved state and resumption checks](../../docs/DSH_RESUMPTION.md).

Core Pipeline remains the task authority. One native worker executes a bounded
task in its own checkout; an independent command verifies the result, then the
existing review flow can publish the accepted snapshot as a draft PR. There is no
separate scheduler or deployment workflow.

The Linux DSH Studio and headless worker wrappers use the existing Core claim
protocol through `with-agentx-claim.js`. Claims are held through child termination,
heartbeat and release/restore verification. Both wrappers keep one host-wide lock;
the headless worker always uses Bubblewrap and the existing no-fanout patch.

These are optional native processes, not another AgentX deployment. Install DSH
and its account-free local model settings outside Git. Set:

- `DSH_AGENTX_CLAIM_HOST`: the exact inference origin being reserved.
- `AGENTX_CORE_URL`: the canonical Core URL (default loopback port 3180).
- `DSH_MODEL`: headless expected model from external DSH settings.
- `AGENTX_MODEL_LIFECYCLE_LOCK_FILE`: the same lock used by other clients of that
  inference host.
- `AGENTX_NODE_BIN`, `AGENTX_CLAIM_WRAPPER`: optional executable/path overrides.

DSH remains under `$HOME/dsh`, settings under `$HOME/.dsh/settings.yaml`, and
workspaces/receipts outside Git under `$HOME/dsh-workspaces`. Configure the local
Ollama provider to use `OLLAMA_AGENTX_API_KEY` when it requires a placeholder key;
`local-no-auth` is not an external service credential. Model fields in wrapper
receipts describe configuration, not independent observed-model proof.

Studio binds loopback only. Configure its reverse proxy and same-host secure
access check with Core's explicit `DSH_STUDIO_*` settings. No service, schedule,
model, host or remote worker is installed by this repository's launcher.

## Dispatcher and draft PRs

The existing native dispatcher, request receipts, worker helper, scratch contract
checks, verification and PR publication live alongside these wrappers.
Repository selection is `agentx`; the source revision comes from the clean canonical checkout. There is
no Product pin or second repository to synchronize. Task scopes and policy
fingerprints created for the archived repositories must be retargeted explicitly
before execution.

Worker prompts retain complete verifier output, operator/coding-team discussion
and supplied Planning text. The dispatcher does not shorten these inputs;
inference admission and the existing task scope, tools and turn budgets still
apply. Dispatcher reports stay separate from the discussion, and Planning remains
untrusted reference data that grants no permission.

Copy `config.example.json` outside Git to
`~/.config/agentx/coding-dispatcher.json`, or set `AGENTX_CODING_CONFIG`. Configure
the actual native SSH target, worker checkout under its OpenClaw workspace,
canonical `sourceRepo`, worker helper, model alias, existing verification command
and measurement host there. Keep native files and credentials outside Git.
`AGENTX_CODING_CA_FILE` is optional when an instance needs a private CA; otherwise
normal system trust is used. No repository-bundled certificate is required.
When using `AGENTX_INSTANCE_ROOT`, the default is its
`config/coding-dispatcher.json`. Mount that same external file read-only for Core's
native model-policy projection; `AGENTX_CODING_CONFIG` can select the mounted path.
The native launcher and Core must read one instance configuration, not two copies.

Inspect admission without launching anything:

```bash
python3 integrations/coding/coding-dispatcher.py --config /external/coding-dispatcher.json --mode shadow
```

The existing Core dispatch control uses `coding_dispatch_control.py`, which
reuses a transient systemd user unit and host flock for the one-shot wrapper.
Duplicate requests keep the same receipt; a lost HTTP reply is not a new run.
Its wrapper accepts one task ID or selects the first admissible task. Private
personal/family tasks remain excluded. Automatic execution and publication are
disabled in the generic example. No native process is installed by Compose.

When Core refuses an autonomous claim because the coding slot is occupied, the
ticket stays queued with the capacity reason and consumes no attempt. The feedback
is conditional on the observed queued version, so it cannot overwrite a newer
claim. Retrying after capacity becomes available is explicit; this adds no
scheduler. A lost claim response is not automatically replayed.

`coding_team_promotion.py --config /external/coding-dispatcher.json --task-id 0000`
publishes only an accepted, independently verified snapshot when publication is
configured. It requires the instance's GitHub credential and creates a draft PR.
Normal `pull_request` CI runs the existing five jobs; the helper does not dispatch
an obsolete workflow or report CI as passed. Merge and deployment retain separate
receipts, using the same `agentx` launcher.

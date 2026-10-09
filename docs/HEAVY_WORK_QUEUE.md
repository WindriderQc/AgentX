# Heavy work from coding and operator sessions

Core owns heavy-work requests separately from personal/family/engineering tasks.
Each request links to its task, coding session or GitHub issue. Cluster Schedule
shows its estimated window beside recurring work. A slot does not acquire a GPU:
native Benchmark, Profiler and image admission/restoration remain authoritative.

## Operator entrance

Use the operator origin from the instance sheet. Core keeps its existing private
LAN human access and native caller attribution; a caller name is not authentication.
The browser-origin guard refuses cross-site writes. Native consumer credentials
and family boundaries remain separate; no maintenance tools are added to Nestor.

```bash
node integrations/operations/heavy-work-queue.cjs list --core <core-origin>
node integrations/operations/heavy-work-queue.cjs submit --core <core-origin> --actor codex --file /path/outside/git/request.json
node integrations/operations/heavy-work-queue.cjs reserve --core <core-origin> --actor operator --id <request-id> --revision <current-revision> --start <ISO-time-with-offset> --priority 5
node integrations/operations/heavy-work-queue.cjs run --core <core-origin> --actor operator --id <request-id> --revision <current-revision>
```

`run` explicitly launches the saved request; there is no automatic start or
arbitrary shell executor. Existing approval requirements still apply. Smaller
priority numbers appear first; the owner chooses the slot and launch. Benchmark
uses `<core-origin>/benchmark` unless `--benchmark` names a verified service origin.

A synthetic request (real manifests remain outside public Git):

```json
{
  "key": "stable-request-identity",
  "title": "Profile a selected local model",
  "kind": "profiler",
  "hosts": ["http://127.0.0.1:11434"],
  "estimatedMinutes": 30,
  "source": {"type": "coding", "ref": "coding-session-reference", "taskId": "0123"},
  "executor": {"hostId": "registered-profiler-host", "depth": "standard", "modelNames": ["installed-model"]}
}
```

Supported executors:

- **Benchmark**: `{plan, request}` names the exact existing prepared `bp-…`
  plan and its typed request, including its judge. The hosts cover both exact
  endpoints. The CLI verifies the local plan, uses its existing maintenance
  action/LEAD lease and rechecks the queue window after preflight, immediately
  before dispatch. Its external env/project/receipt configuration is required.
  Queue preparation itself as `{prepare: true, request}` with an explicit judge;
  its returned plan becomes a receipt, not an automatically launched campaign.
  Submit a second linked request with `{plan, request}` to run that plan.
- **Profiler**: `{hostId, depth?, skipRecentDays?, modelNames?}` runs the existing
  host queue. Core checks its registered endpoint; the native tracker carries
  the Core request identity for subsequent observation.
- **Image**: the existing image request with `actionKey`, `prompt`, profile,
  dimensions, seed and optional archived parent/recipe. Core checks configured
  GPU consumers. Use artifact references instead of large binary payloads.
- **Diagnostic/other** requests may be planned without an executor. They do not
  dispatch until a bounded executor with admission/evidence support exists.

Normal isolated unit tests, source checks and builds remain direct. Tests that
invoke live inference, load/unload models, render images, run a Profiler or
benchmark campaign, or occupy shared compute for minutes go through the queue.
Preflight/preparation that invokes a model is itself heavy work.

## State, recovery and history

`requested → reserved → dispatching → running → completed/failed/cancelled`.
Ambiguous effects become `uncertain`. Intent is immutable. Submission keys replay
the same identity; changed content under a used key refuses. Edits need the
current revision. One Mongo CAS serializes all planned host/device windows using
Core's physical-resource aliases; unmapped endpoints remain independent.

The dispatch mark is durable before the effect. Concurrent sessions cannot both
begin a request. Early/expired manual/API starts refuse. Running/uncertain work
stays fenced after the estimated end. Topology changes require reconciliation.
The Core observer reads existing executor receipts every 15 seconds, without
launching, retrying, cancelling or releasing native authority. A completed result
does not settle the request while overlapping native workloads or inference
admissions remain held, including quarantined or uncertain outcomes.

Use `reconcile --id …` on demand. Cancel unstarted requests with `cancel --id …
--revision …`. Cancel running work in its native executor, then reconcile.
Profiler tracker loss after restart may require operator recovery; a missing
endpoint never proves termination. After independently verifying termination
and native release, an operator can record the external recovery receipt:

```bash
node integrations/operations/heavy-work-queue.cjs recover --core <core-origin> --actor operator --id <request-id> --revision <current-revision> --dispatch-id <dispatch-id> --receipt <verified-receipt-reference> --confirmation EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED
```

This records **operator reconciliation**, not an independently verified native
result. It refuses while overlapping native authority remains held and never
stops a process, deletes an admission or clears quarantine.

`archive` writes/verifies immutable terminal receipts before removing active
rows. Keys stay deduplicated and `show` still resolves archived identities.
The active singleton explicitly refuses new work beyond 400 requests or 8 MiB (with space reserved for terminal receipts) rather
than dropping history. Archives belong to the same Core database and backups.

## Legacy transition and API

When Core has no queue and `/instance/config/QUEUE.md` is mounted, writes refuse
until migration. `list` returns its digest; `migrate --sha256 …` confirms that
exact snapshot. Core retains the complete Markdown, notes/history included,
and imports waiting rows without guessing dates, durations or endpoints.
Reconcile legacy running rows first. Review each waiting row, submit an explicit
linked replacement and cancel its old imported row.

After migration, Core is the sole planning authority; the old file is an archive.
Cluster Schedule downloads a readable current Markdown snapshot, not a second
scheduler or lease. Migration/export never launches work.

The base API is `/api/cluster/schedule/work-queue`:

- `GET /`, `POST /`, `POST /migrate`: list, submit, confirm the legacy digest.
- `GET /:id`: read an active or archived request.
- `POST /:id/reserve`, `/begin`, `/assert-dispatch`, `/record`, `/cancel`,
  `/reconcile`, `/recover`: bounded transitions.
- `GET /export`: download the current Markdown snapshot.
- `POST /archive`, `GET /archive?offset=0&limit=50`: preserve terminal receipts,
  then page their full records with an exact total.

Runtime manifests, private references and receipts remain outside public Git.
Synthetic/disposable Mongo tests do not prove installation, migration or live
GPU/device qualification.

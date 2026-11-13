# Native recovery sets

The operations supervisor composes complete private recovery generations with
`integrations/operations/recovery-set.py`. Existing Core Mongo/config/Qdrant
backups keep their own schedule. This additional adapter covers native Hermes
and OpenClaw state, source revisions, private parameters and **all** Qdrant
collections, including collections other than the active document index.

Configuration is external; start from the synthetic
[example](../integrations/operations/recovery_set/config.example.json). No home
paths, actual host inventory, credentials or private payloads belong in public Git.

## Native capture and validation

A named `recovery-capture` job uses Core's heavy-work operator admission before
native backup, snapshot and isolated restore operations. The configured `source`
links the authorized recurring work to its session/task or issue. Every occurrence
retains one native supervisor UUID, queue key, dispatch ID and terminal release
receipt. It never loads a model or takes a maintenance lease for the capture.

Hermes owns backup/import and process-marker exclusions. OpenClaw receives a
separate private source copy with coherent online SQLite snapshots, relocation
metadata and separately preserved historical trees. Its own backup/verify/restore
commands own cache and transient-state exclusions; originals remain untouched.
Required credential targets are selected explicitly in the private configuration.

Mongo is captured with native `mongodump`, never a live directory copy. Qdrant
creates one full native storage snapshot. An ambiguous snapshot response is fenced:
Qdrant does not promise idempotent snapshot creation, so it is never replayed.

Before publication, the adapter imports every Hermes archive into a fresh home
and compares durable files and SQLite contents. It receives OpenClaw's native
restore and compares workspace instruction/personality/memory files. Disposable
Mongo and Qdrant containers use `--network none`, no published ports and no live
volume mounts. The Mongo critical owner/catalog collections must match; every RAG
point, vector and payload must have the same canonical digest after restoration.
Native backup exclusions and OpenClaw's operational audit migrations still apply.

Critical owner notes, catalog history, embedding profile and configured files/trees
must remain stable across capture. Each store owns its native snapshot; this is
not a cross-store transaction or continuous replication. Histories, forgotten states
and IDs stay in the original stores instead of being reimported as new memory.
No receipt claims a fresh conversation/model-turn acceptance.

## Publication, transfer and retention

Only a fully verified generation is renamed into `generations/<UUID>` and made
`latest.private.json`. Failed or incomplete copies never replace that pointer.
The manifest freezes artifact lengths, SHA-256 values, sources and capture evidence.
The generation contains its private configuration and [restore procedure](../integrations/operations/recovery_set/RESTORE.md).

A separate named `recovery-replica` job uses existing SSH credentials/host keys
and rsync. It resumes the same incoming generation after interruption. The destination
reads and checks every artifact before atomic publication. A lost commit reply is
reconciled against the same manifest, not a new generation. Unchanged complete
copies are reverified without another upload. Automatic retention is confined to
owned UUID generations and protects the latest good copy. Source pruning requires
a verified off-host receipt; an unreachable destination never destroys the source.

Set bounded source/destination `keep` counts (at least two), a destination free-space
reserve and an explicit freshness threshold. Source runs and uncertain evidence stay
private beside their native receipts. An external `health` setting may publish a
numeric freshness event to existing Core alert intake; alert rules/delivery remain
instance configuration and no mail/Telegram action is added by this adapter.

## Supervision and recovery

Use the **existing native operations supervisor**, not another writable schedule.
Add `recovery-capture` and `recovery-replica` jobs with `python`, `script`, `config`
and `stateRoot` options in the private worker configuration. `transport: "local"`
runs the named worker beside the server data; workstation jobs retain their existing
SSH transport. The same private server recurrence appears in Automations.

An hourly capture check can enforce `minimumCaptureIntervalSeconds` (for example
six hours), with `refreshOnCriticalChange` also detecting changed instructions,
local memories, owner notes or catalog records. Replication can retry hourly.
`staleAfterSeconds` measures the age of the **captured state** on the off-host copy,
not the date of the latest attempted transfer. Choose all times in the instance.

Deferred, proven failures/offline transfers stay explicit in `attemptState`,
`attemptVerified` and `fresh`; the next normal occurrence retries. The supervisor's
successful check means the check ran, not that a deferred backup was verified.
An ambiguous native effect exits 3, preserves its original queue/worker fences and
blocks replacement. Reconcile its original native result; never clear a quarantine
or delete coordination records to resume. A queue terminal response is required
before capture cleanup. The native [job protocol](OPERATIONS_JOBS.md) and
[heavy-work protocol](HEAVY_WORK_QUEUE.md) retain their authority.

Validate with synthetic tests:

```
python3 -m unittest discover -s integrations/operations/tests -p 'test_recovery_set.py'
python3 -m unittest discover -s integrations/operations/tests -p 'test_host_jobs.py'
```

A native installation must additionally receive one full capture, isolated imports,
verified off-host transfer and scheduled-supervisor receipts before being reported
as active. Detailed private receipts are not copied into Git.

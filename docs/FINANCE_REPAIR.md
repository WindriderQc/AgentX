# Bounded Finance book repair

Core's native operator executor moves one whole reviewed statement and its exact
transaction set between personal and corporate books. It changes the book prefix
only, preserving any existing manual decisions. Account-number normalization,
document-link reassignment, re-extraction and bulk historical correction remain
outside this contract. The original PDF never moves or changes.

The implementation lives in `core/src/services/finance/financeRepairExecutor.js`.
`core/scripts/finance-repair.js` is its operator entrance; no mutation route,
MCP grant or persona authority is added. Ordinary Finance clients retain their
existing tools and APIs.

## Admission and native ownership

`finance_coordination` holds one admission document. Guarded Finance service
calls, model queries/writes, inbox scans and streaming CSV iteration register
shared operations. Nested operations reuse their admission; an early rejection
waits for already-admitted database work to settle. Streaming admission remains
held until the iterator finishes or closes.

A repair first records durable intent and closes admission to new Finance work.
Already-admitted work drains; `FINANCE_REPAIR_DRAINING` retains the same request
and returns without an accounting write. Subsequent normal reads and writes
receive `FINANCE_MAINTENANCE` (503). Repair observation stays available through
`GET /api/finance/maintenance`, which returns a protocol and database identity,
not figures or execution credentials.

The operator must name the native loopback Core origin. Before dispatch, the
executor verifies that Core advertises `agentx.finance-maintenance/v1` for the
same coordination database, then verifies that its ordinary inbox API actually
refuses admission while the repair holds it. All Core Finance writers must run
this implementation before application; an old service or a direct database
administrator is not made safe by a new CLI alone.

Each executor also holds a Linux kernel `flock` on its private receipt root.
The writer retains the locked file descriptor itself; a helper's death cannot
release it under a living writer. Mongo pins the root identity, refusing a
second root used to bypass that lock, including a copied root marker on another
inode. The binding includes the Linux boot identity and locked device/inode.
The kernel releases the process lock on
executor death, while Mongo's Finance exclusion stays held. Another executor
can then reconcile the same immutable request, never run alongside its old
writer. There is no time-based lock expiry or automatic quarantine clearing.

An abandoned ordinary admission also remains recorded. A missing process does
not prove that its native operation completed safely. This executor does not
delete those admissions; their owning operation must be reconciled separately
before a repair can drain. Raw Mongo access is reserved for the native executor,
deployment/index maintenance and explicit administration; external runtimes
continue to consume Core's APIs.

## Reviewed manifest

The private JSON file has a stable `requestKey` and a `verifiedIdentity` naming
the PDF hash/path, period, issuer, reviewed account suffix and target book.
`schemaVersion: 1` retains the original one-row/one-decision contract unchanged,
including its existing manifest digests and receipts. `schemaVersion: 2` accepts
one complete statement with 1–50 transactions and 0–50 existing owner decisions,
at most one per transaction. Both versions group `updates` in this order:

1. `finance_statements`: exactly one reconciled statement.
2. `finance_transactions`: every existing row of that statement, sorted by ID.
3. `finance_overrides`: exactly the decisions of its manual rows, sorted by ID.

Version 2 also requires `verifiedIdentity.transactionOrder`, an object mapping
every statement account code to its row IDs in the verified original's printed
order. Zero-row accounts have an empty array. This order is separate from update
ID order: several same-day rows may have balances that only reconcile in their
printed sequence. Each running balance and each closing equation must reconcile
exactly in integer cents. Missing/extra rows, duplicate identities, unlisted
manual decisions and either source or target document links refuse execution.

Each update carries its existing `id`, full `before` image, canonical
`expectedBeforeSha256`, `matchCountRequired: 1`, `insert: false`, `upsert: false`,
the proposed `set` and `setAtExecution: {updatedAt: "receipt.appliedAtUtc"}`.
The CLI confirms the SHA-256 of the **original manifest bytes**. A different
file under an existing request key is refused, even if its proposed changes
look similar.

The service derives the allowed field changes from the current book and native
ledger prefixes. It rejects arbitrary update expressions, amount/category/tag
changes, normalization of a missing account number, or an unmatched owner
decision. All account closing equations, every printed running balance and the wallet
flow signs must reconcile in integer cents. A matching source/target document
link or an occupied destination identity requires another review. This bounded
executor does not guess how to migrate such a link.

All reviewed images in Mongo must still match their exact before images. The original
must resolve inside the configured Finance archive and match its SHA-256.
The owner's category, tags, manual flag, author and creation date survive;
the decision's stable account key follows its row. No rules or document
proposals are recomputed.

## Durable effects and recovery

`finance_repairs` owns intent, typed before/after images, scope signatures,
direction, step observations, errors and terminal receipts. It has no TTL.
The executor also writes private immutable evidence using fsync and atomic
publication: the complete bounded Finance snapshot, expected target signatures,
received after state and rollback state. It refuses snapshots above 32 MiB.
Receipt paths and real manifests belong outside public Git.

MongoDB standalone does not provide a multi-document transaction for these
bounded writes. The executor therefore retains exclusion across all of them.
Each replacement checks its before image and uses native unique indexes.
After interruption, each actual document must match either its saved before
or after image; matching after means the effect was received and must not be
repeated. Counters alone never decide whether a write ran. Every command is preceded by
its durable dispatch intent. If a process disappears after dispatch and the
image is still the source, `FINANCE_REPAIR_WRITE_UNCERTAIN` keeps admission
closed: an unanswered command might still arrive. Neither resume nor rollback
resends or reverses that uncertain command. Its exact destination proves its
single effect was received; otherwise the native owner must reconcile its
outcome separately, even when the crash happened before the actual send. Other accounting
documents must match their protected signatures, and the latest balances must
remain unchanged for this historical contract.

The terminal receipt is saved durably before admission is released. A lost
terminal reply replays that receipt with its original completion date; it is
historical evidence, not a fresh claim that current figures still match it.
An ambiguous write, unrecognized image, changed evidence or drift during a
partial operation retains exclusion. Resume the same request after native
reconciliation; never delete coordination records, clear a held request or
submit a replacement to get around it.

An operating-system reboot or replacement of the lock inode changes this
binding and refuses execution. Rebinding after that event requires separate
native-owner reconciliation; this executor never interprets a changed host or
missing lock file as permission to clear an exclusion.

Rollback runs under the same process lock and Finance exclusion. It restores
only the exact reviewed before images, including missing legacy fields and
old timestamps, and keeps both application and rollback receipts. A later owner
decision or occupied old identity refuses rollback rather than overwriting it.
Unrelated changes made after a completed application are retained. Once
rollback intent is saved, `resume` follows rollback, not forward application.

## Operator entrance

Run beside the same installed Core, with its native Mongo configuration and
these explicit external settings:

| Setting | Meaning |
|---|---|
| `MONGODB_URI` | The instance's native database; never inferred |
| `AGENTX_CORE_URL` | Native loopback Core origin, including its actual port |
| `FINANCE_ARCHIVE_PATH` | Absolute original archive root |
| `FINANCE_REPAIR_ROOT` | Absolute private directory (0700) on a filesystem supporting Linux flock, hard links and fsync |

After accounting review and explicit authorization for that exact manifest:

```bash
node core/scripts/finance-repair.js apply --manifest /private/reviewed.json --confirm REVIEWED_SHA256 --actor operator
node core/scripts/finance-repair.js resume --manifest /private/reviewed.json --confirm REVIEWED_SHA256 --actor operator
```

An explicitly authorized reversal uses `rollback` with the same file and digest.
Preparing a manifest, testing a copy or installing the executor does not
authorize application. Changing the private root to escape a held operation is
refused; restore the original root and its native evidence instead.

No command invokes a model. Any later extraction or shared model qualification
is a distinct approved request in the [Core heavy-work queue](HEAVY_WORK_QUEUE.md).

## Verification scope

`core/tests/services/financeRepair.test.js` uses disposable local Mongo and
synthetic originals. It exercises admission drain, model/API/scan/stream refusal,
kernel-lock contention, changed intent and evidence, collisions, preserved
decisions/links, exact rollback and actual SIGKILL at write/receipt boundaries.
`core/tests/services/financeStatementRepair.test.js` adds complete-row and
zero-decision cases, printed-order checks, later-row SIGKILL and uncertain-dispatch
recovery, destination/link conflicts, preserved decisions and exact reverse
rollback. The existing finance service/profile tests remain required. These checks prove
source behavior on disposable databases, separately from installation,
accounting authorization and a live repair receipt.

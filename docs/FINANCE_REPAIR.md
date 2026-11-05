# Bounded Finance statement repair

Core's native operator executor moves one whole reviewed statement and its exact
transaction set between personal and corporate books. It changes the book prefix
only, preserving any existing manual decisions. Version 3 also retains the
statement's exact document links in place. Version 4 corrects a reviewed card
issuer within its existing book, retaining the exact rows, decisions and links.
Version 5 corrects a reviewed card's printed dates/period and restores at most
ten missing rows within that same existing statement. Account-number normalization,
re-extraction and bulk historical correction remain outside this contract.
The original PDF never moves or changes.

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
executor verifies that Core advertises `agentx.finance-maintenance/v2` for the
same coordination database, then verifies that its ordinary inbox API actually
refuses admission while the repair holds it. All Core Finance writers must run
this implementation before application; an old service or a direct database
administrator is not made safe by a new CLI alone.

Version 3 additionally requires the served maintenance response to advertise
`agentx.finance-linked-book-repair/v1`. A CLI upgrade alone cannot qualify an
older document synchronizer that would delete migrated proposals.

Version 4 also requires `agentx.finance-issuer-repair/v1`. The installed reader
and executor share the same deterministic latest-balance projection.

Version 5 requires `agentx.finance-printed-card-repair/v1`; updating only the
operator CLI cannot qualify an older running reader.

The v2 maintenance protocol also excludes pending ordinary ingestions. Their
native writer and recovery entrance are described in [Finance](FINANCE.md).
Existing v1/v2 repair manifest digests and receipts remain unchanged. Statements
with explicit `rowKeys` membership require a separately reviewed membership-aware
repair and are refused by this legacy-identity repair contract.

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

`schemaVersion: 3` extends the same complete-statement contract with up to 50
existing document links, appended after the decisions and sorted by ID (151
updates maximum). `verifiedIdentity.documents` contains the exact normalized
Secretary records referenced by those links. Their current bytes must match
before dispatch. Every link must already refer to one reviewed outgoing row,
its amount and document snapshot; unlisted relations, duplicate documents and
occupied destination keys refuse execution. Earlier versions still refuse links.

`schemaVersion: 4`, `operation: "issuer-reassignment"`, is a separate closed
card operation: one reconciled legacy statement, 1–100 liability-account rows,
their existing decisions, and at most 50 existing links (251 updates maximum,
within the same 256 KiB file bound). The verified target issuer must use Core's
canonical issuer normalization. Statement/account keys are derived by the native
ingestion identity functions, retaining the book and missing account suffix.
Only the issuer and identity prefixes change; no ledger field is added or moved.
Null categories, absent manual fields and null running balances are retained.
Every account's opening plus its complete row sum must equal its closing in safe
integer cents. This validates issuer reassignment, not a fresh extraction or a
claim that every historical description/date/category is correct.

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
flow signs must reconcile in integer cents. An unlisted source/target document
link or an occupied destination identity requires another review. This bounded
executor never infers new document associations.

All reviewed images in Mongo must still match their exact before images. The original
must resolve inside the configured Finance archive and match its SHA-256.
The owner's category, tags, manual flag, author and creation date survive;
the decision's stable account key follows its row. No rules or document
proposals are recomputed.

Version 3 changes only a link's stable key, transaction account prefix, document
book and native update timestamp. It adds `bookRepair` provenance containing the
request key and the exact normalized document digest. The same link ID,
document ID, status, ambiguity, decision author/date and both snapshots' other
fields survive. Migration does not confirm a proposal or recategorize a row.

Document consultation honors this scoped assignment without changing the
Secretary register or global corporate-name configuration. Retained links are
not regenerated or refreshed. Ordinary unchanged proposals also keep their
timestamps; owner decisions are never recomputed. A changed/missing registered
document or missing/moved payment returns `FINANCE_DOCUMENT_REPAIR_CONFLICT`
before synchronization writes, preserving the relation for native review. A
later owner confirmation/rejection remains possible and refuses an old rollback.

## Reviewed issuer balance effects

Changing an issuer can remove a spurious account from latest-balance views or
change which historical statement supplies one. Version 4 therefore requires
`expectedAccounting.balanceProjection.beforeSha256` and `afterSha256`, hashes of
the reviewed native `{perso: {accounts}, corp: {accounts}}` projections. It
derives the target from the whole protected statement snapshot with the same
projection as the reader and verifies both hashes before the first write. The
actual native after view must then match exactly. A transaction or printed
statement amount never changes to manufacture that result.

Issuer receipts use `agentx.finance-issuer-repair/v1`, with
`reviewedBalanceProjectionMatched: true` and the actual
`latestBalancesUnchanged` boolean, which may be false. Existing v1/v2/v3 manifests
and receipt bytes retain their unchanged-balance interpretation. The exact
issuer balance effect belongs in the private owner review before authorization.
Rollback verifies its restored projection before dispatch and afterwards; a
later unreviewed balance change or owner decision refuses reversal. Full source
evidence, same-request recovery and ambiguous-dispatch refusal remain in force.

## Durable effects and recovery

### Printed card correction

`schemaVersion: 5`, `operation: "printed-card-correction"`, reviews exactly one
existing reconciled legacy card statement with one liability account, at most
100 complete rows, their existing owner decisions and at most 50 links. Up to
ten rows may be explicitly absent. It never restores an absent statement or
changes issuer, book, suffix, existing amounts, flows, fingerprints, occurrences,
descriptions, categories, tags or manual field presence.

`verifiedIdentity.printedRows` contains every printed reference, pinned row ID,
transaction/posting date, description and integer amount. Both dates must be
real calendar dates; posting must be within the reviewed period. A transaction
may predate that period but cannot post more than 31 days later. Every existing
row must match its reviewed printed amount and description prefix (wrapped
descriptions are preserved). The complete printed sum must reconcile to the
unchanged opening and closing amounts, without unsafe intermediate arithmetic.
Only the reviewed period, its native statement key, existing transaction dates
and the associated decision/link dates and stable keys may follow the source.

Every existing row is included, even when it needs no edit. Such an update has
`set: {}` and `setAtExecution: {}`; its bytes and original timestamp remain
unchanged. Existing changes retain the v1–v4 before-image form. A new row uses
`before: null`, `expectedBeforeSha256: hash(null)`, a pinned ID, `insert: true`,
`upsert: false`, `matchCountRequired: 0` and native `createdAt`/`updatedAt`
execution timestamps. Its full `set` is derived by the closed contract: native
account/book identity, source date/description/amount/flow/fingerprint, occurrence
one, null running balance and category, empty tags, `manual: false`, and
`sourceRepair` with the request, PDF hash, printed reference and row digest.
It cannot insert a decision or a document link, fabricate a balance or choose a
category. Duplicate row identities or occupied IDs/keys refuse before dispatch;
indexes are never removed to stage a correction.

The linked-document contract retains the same link ID, document, proposal or
decision, ambiguity, original creation and decision metadata. Its transaction
date/key follows the exact existing row and its register digest is pinned with
the same scoped retention used by earlier repairs. It remains readable even if
the corrected date leaves the ordinary matching window. No relation is confirmed
or inferred by this executor.

The reviewed `expectedAccounting.balanceProjection` hashes must be equal:
correcting historical dates must leave every latest account identity, amount and
date unchanged. `monthlyProjection.beforeSha256` and `afterSha256` separately
pin all stored monthly counts, incoming, outgoing and net cents in both books.
The reader and native proof share the monetary aggregation. The executor checks
the actual native before view and independently derived complete target before
writing, then verifies the exact actual monthly after view. Existing monetary
facts do not change; restored rows and corrected dates can change historical
monthly totals only as reviewed. Coverage metadata and calendar zeroes do not
enter these raw-money hashes.

Receipts use `agentx.finance-printed-card-repair/v1`, distinguish
`reviewedDocuments` from changed `documents`, and report actual expected
`updated`, `inserted` and `deleted` effects with both projection proofs. Retained
rows do not count as changes. A partial rollback counts only the effects present
at its durable rollback intent; it cannot claim deletion of an undispatched row.
An absent source image is not proof that a dispatched insertion failed. An
uncertain insert or reverse deletion retains admission until its exact original
outcome is reconciled, with no replacement dispatch. Reverse order removes only
the pinned inserted rows and restores exact original images. Later changes to a
restored row, owner decision, document relation, balance or reviewed monthly money
refuse the old rollback instead of overwriting them. Earlier manifest versions
and receipt semantics remain unchanged.

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

The v1/v2 balance proof retains its original `{accounts}` projection in each
book. New read-response coverage metadata does not enter that comparison:
moving historical sources can change coverage while the latest account
identities, amounts and dates remain exactly unchanged. Existing manifest
digests and saved balance proof bytes retain their original interpretation.

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

`core/tests/services/financeLinkedRepair.test.js` covers scoped document
assignment, all link statuses, preserved ambiguity and decisions, repeated
document consultations, source drift, link/destination conflicts and actual
process interruption during link application and rollback.

`core/tests/services/financeIssuerRepair.test.js` adds the complete card row
bound, null category/balance preservation, safe arithmetic, false-account removal,
reviewed balance hashes in both directions, unchanged owner decisions and
ambiguous document links, native document consultations and actual interruption.

`core/tests/services/financePrintedCardRepair.test.js` covers exact source dates
and periods, bounded absent-row insertion, byte-identical retained rows, monetary
projections, source/identity/decision/link drift, retained ambiguous document
consultation, full/partial rollback and actual process death at insert and
reverse-deletion dispatch/receipt boundaries. It proves uncertain outcomes stay
held until the exact native effect arrives, without duplicate insertion or loss
of a later owner decision.

# Photo relocation preflight

## Chosen data ownership

Image bytes stay intact. Each image travels with its XMP companion. The existing
photo card and decision collections remain the central register; their JSON
[export](PHOTO_PORTABLE_REGISTRY.md) is portable but not a full media backup.
There is no second spreadsheet catalogue, no embedded-metadata rewrite and no
production migration endpoint in this capability.

`photoRelocationInventory` observes an exact image/XMP pair and its proposed
filesystem destination without writing. `photoRelocationPreflight` combines
that observation with an explicit owner registry selection and checks the
registry manifest again after inventory. Its result is always non-executable,
`migrationReady:false`, and lists unresolved operational requirements. The
second observation detects changes; it is not a transactional writer fence.
The resolver and inspector are mandatory trusted operator dependencies. The
module has no implicit NAS paths or production transport. No caller can turn a
boolean into permission to move a file.

## Integrity observations

The native resolver must obtain the image identity from the verified import
receipt and the companion identity from its owned sidecar journal. A freshly
computed hash alone does not prove provenance. Inputs do not authorize any
filesystem access outside the operator's approved roots. The inspector rejects
missing/changed files, symlinks, incompatible destination pairs, occupied destinations and
cross-device relocation. It makes no claim to validate network permissions,
backups, application metadata completeness or concurrent jobs.

An image and its XMP are distinct files, never treated as one atomic rename.
A hardlink is not an independent backup. Immutable import receipts remain
historical evidence; a separate, versioned relocation record must resolve their
current paths before existing readers can survive a move.

## Required implementation boundaries

| Boundary | Required evidence before real effects |
| --- | --- |
| Content and backup | Exact selected identities; independent backup plus restore verification; immutable image SHA/size and XMP versions |
| Reference readers | Import retry, occurrence/preview, phone cleanup backup checks, projection lookup, reviews and sidecar writer all resolve relocation history |
| Writer fencing | Photo owner decisions, native import/projection writers, Immich watchers, scheduled scans and extraction cannot race relocation |
| Destination visibility | Same or narrower permissions in filesystem, Immich and Family; frame selection alone does not authorize new metadata visibility |
| Metadata snapshot | Complete API-exportable descriptions, dates, tags, location, favorites, albums/ACL, piles, face information and app records, with explicit unsupported fields |
| Filesystem operation | Durable intent and journal; no-replace publication; controlled same-filesystem pair move; fsync; resume after every interruption |
| Immich reconciliation | New external asset ID mapped to existing stable content identity; explicit association restore; bounded indexing without ML reanalysis |
| Rollback | Source restoration and binding rollback proven; refuse changed destinations or newer human decisions rather than overwrite |

The registry already identifies unchanged content by SHA-256. Relocation must
not rewrite the old import path in an immutable receipt or use a database patch
against Immich. The current `PhotoProcessingDecision` journal can carry the
operation's identity, but its existing review/frame consumers require explicit
versioned relocation handling before a new decision kind is activated.

## Immich implications

The installed external-library contract binds assets to paths. A real move can
create a new asset, even when its bytes are unchanged. `PUT /assets/copy` copies
selected associations, not the image. All options default to false in the
preflight: albums, sidecar, sharedLinks, stack, favorite. No request is sent when
there is nothing approved to transfer. A future adapter must opt into only the
reviewed associations and verify the resulting access.

`sidecar:true` can replace an existing target sidecar and queue metadata
extraction. Indexing can queue sidecar discovery/extraction and subsequent jobs.
These effects require an isolated-instance qualification; the AgentX analysis
pause alone does not control Immich jobs. No scan or live inference is issued by
these modules.

## Test boundary

Tests use fictional bytes and temporary test directories only, with synthetic
register observations. They verify refusal paths and read-only planning, not
real migration, Immich restoration, image decoding or independent backup.
The preflight does not silently clear its blockers, even when all filesystem
checks pass. The live slideshow is unaffected by this isolated preparation.

## Existing source layouts

The current managed XMP sits next to the Immich projection, while the canonical
import receipt can point to another hardlink path for the same image bytes.
The inventory therefore permits distinct source locations under the approved
source root, but requires the destination XMP to be `image.ext.xmp`. The trusted
resolver must obtain that companion from its sidecar journal, not guess it from
the original path. A future move must inventory every old reference explicitly:
moving just the projection does not consolidate the canonical original, and
leaving hidden links permanently is not the chosen completed outcome.

The final location record must connect all original receipt occurrences to the
new canonical image and its unchanged SHA-256. Source aliases cannot be retired
until the new image, companion, registry and Immich binding are verified and a
rollback has been qualified. These are scoped reference retirements, never a
global duplicate purge. No such operation exists in this preflight.

## In-memory fault model

`core/tests/fixtures/photoRelocationSandbox.cjs` is only a test fixture. It
models fictional bytes, file identities and an operation journal using Maps;
it imports no filesystem, network, database or production adapter. Simulated
unknown effects require reconciliation before replay, and rollback refuses
changed content or occupied sources. Its CAS is single-process in-memory, not
durable or distributed. Passing these tests does not qualify a real executor,
permission change, Immich rebind or crash recovery after process loss.

## Persistent synthetic process-crash harness

`core/tests/fixtures/photoRelocationCrashWorker.cjs` runs only against fixed
sentinel filenames in freshly marked OS temporary directories. Separate Node
processes persist an integrity-checked journal and a single-worker lock. Tests
interrupt forward and rollback before/after each image/XMP rename, then require
explicit observation before replay. Changed destinations, occupied originals,
corrupted journals and live locks refuse progress. Only fictional text is used.

This is not a production executor. SHA-256 detects accidental journal changes,
not malicious rewriting. The controlled process exits do not simulate power
loss or journal-write interruption. Directory fsync is explicitly unsupported on
the tested Windows runtime; Linux support alone is not a storage durability
proof. The collision check plus rename is not atomic no-replace against external
writers. Network filesystems, ACLs, adversarial races and real Immich bindings
remain unqualified. No runtime imports this test fixture.

The [isolated Immich qualification plan](PHOTO_IMMICH_QUALIFICATION.md) describes
future synthetic-instance checks; it is not a record of an executed migration.

Filesystem identity observations use BigInt stat values internally, including
nanosecond timestamps. Device/inode and timestamps are decimal strings in JSON
evidence; adapters that discard exact integer precision are refused. This
prevents distinct large Windows file IDs from collapsing into one Number.

To run only the process-crash suite without database setup:

```sh
cd core
node node_modules/jest/bin/jest.js --config '{"testEnvironment":"node","testMatch":["**/tests/services/photoRelocationCrash.test.js"]}' --runInBand
```

Run read-only registry/inventory/preflight tests separately with the repository's
`shared/testing/noDatabase.js` guard. That guard intentionally forbids subprocess
creation and must not be weakened to run the process-crash harness.

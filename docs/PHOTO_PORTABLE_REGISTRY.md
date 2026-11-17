# Portable photo registry export

The existing `PhotoProcessingCard` collection owns one SHA-256 content identity
across imports, the Immich binding, observations and separate human review/frame
decisions. `PhotoProcessingDecision` owns the decision journal. This capability
exports those records; it does not create a second catalogue or spreadsheet.

Images remain unchanged. A future physical relocation must preserve the image
and its XMP companion together, and version its location/bindings without
rewriting original import receipts. This export is a foundation, **not a
relocation executor or a complete backup**.

## Private operator command

In the Core environment with its existing Mongo connection, provide a private
JSON file containing only `sha256s` (one to one hundred unique lowercase SHA-256
identities):

```sh
node scripts/export-photo-registry.cjs /private/selection.json > /private/export.json
```

Use a restricted local destination outside Git and web roots. The document may
contain owner-only descriptions, locations, observations and technical paths.
Do not paste it in logs, public issues, family surfaces or shared spreadsheets.
No HTTP/MCP route exposes this export. A service audience flag is a fail-closed
check, not authentication; the command is for a trusted local operator.

The command disables automatic Mongo collection/index creation, reads the
existing collections, and emits one JSON result only after validation succeeds.
A failed command is not an export receipt; inspect its exit status and do not
use a pre-created empty output file. No photo bytes are read or changed, no
Immich request is issued, and no scan, model, import or cleanup starts.

## Coverage and limits

The export keeps stored observations and decisions distinct. It includes the
current AgentX records, not the original media, XMP bytes, import-ledger files,
all Immich metadata or a portable mapping of every application's permissions.
Stored truncation indicators remain visible. Unknown fields in these records
are preserved rather than silently reduced to a friendly summary.

The observation is non-atomic across collections. It is not permission or proof
to move files, does not fence concurrent writers, and is never migration-ready.
Pending decisions and exceeded bounds are refusals, not silently partial success.
The source database remains authoritative; editing the exported JSON does not
change the live system. The content identity stays stable while image bytes
stay intact; embedding new metadata into an image changes its SHA-256.

## Relocation safety boundary

No file move or asset rebind exists in this command. Such a workflow additionally
requires a complete, versioned inventory, independently recoverable backup,
writer/job fencing, integrity verification, atomic no-replace publication,
all receipt readers resolving the location history, and conflict-aware rollback.
Hardlinks are references to the same bytes, not independent backups.

Immich external assets are bound to paths. A new path can create a new asset;
changing a central registry value alone does not repair Immich, import receipts,
sidecar writers or album/permission relations. In Immich 3.4.0, `/assets/copy`
transfers selected associations rather than moving media. All options require
explicit choices: automatic sidecar copying can replace the target sidecar and
queue extraction, while shared-link/stack copying can change access or grouping.
There is no automatic call to that endpoint here.

XMP transports supported descriptive fields, not every application relation.
The register export preserves AgentX-specific state separately. Destination
indexing must not widen Family access, and image selection for a slideshow is
not permission to expose all metadata. A processing pause alone does not fence
Immich's own watchers, scheduled scans or extraction jobs.

## Synthetic verification

```sh
npm test -- --runInBand --runTestsByPath tests/services/photoPortableRegistry.test.js tests/services/photoRegistryExportCli.test.js
```

The command tests use injected synthetic records and no database or photos.
Service tests additionally cover strict selections, incomplete/pending records,
bounds and metadata preservation. These are not live Immich, XMP round-trip,
filesystem relocation or real-device acceptance tests.

## Read-only relocation preparation

The [relocation preflight](PHOTO_RELOCATION_PREFLIGHT.md) combines this registry
observation with exact image/XMP filesystem evidence through trusted injected
operator capabilities. It remains non-executable and never authorizes a move.

# Verified phone media processing

DiskX composes verified USB imports, Core analysis, Immich and owner review.
The copy worker remains independent: it never waits for an inference, Immich
scan or Core deployment. A phone stays read-only until the owner uses its
separate selected-cleanup confirmation.

## Flow and ownership

1. The NAS capability reads existing Media manifests and verification receipts.
   A whole-import watcher revisits pending receipts as new files arrive. The
   optional `autoProcess` setting enrolls the latest import runs automatically;
   otherwise the owner chooses **Analyser cet import et ajouter à Immich**.
2. Core plans batches of at most 24 occurrences in its heavy-work queue. One
   durable Mongo slot serializes processing across Core processes. Native
   resource admission and the existing `analysis` route retain their owners.
3. Under that window, the NAS rehashes verified originals and creates hard links
   in `<import-root>/.agentx-import/immich-library`. Each SHA-256 has one managed
   reference across imports. Nothing moves or overwrites an original. Cross-
   filesystem links refuse instead of silently making another copy. XMP/AAE
   companions remain backed up and are not standalone gallery assets.
4. A dedicated Immich external library indexes that managed directory. Core
   checks its sole import path before requesting a scan. Original path, library,
   size and the applicable Immich checksum must match the verified reference.
   External libraries may use SHA-1 of `path:<exact-original-path>`; legacy
   assets may use content SHA-1. Neither replaces the NAS SHA-256 readback.
   Assets whose metadata extraction is still pending are revisited. Core
   observes indexing queues and metadata;
   accepting the scan is not completion.
5. Immich supplies EXIF, OCR and existing named face groups. Core records those
   extracted facts separately from a bounded vision proposal. Images use a
   decoded Immich preview, including HEIC originals; videos receive metadata
   cards without an image-model invocation. Models do not guess identities.
6. Content cards and human corrections remain in Core. Immutable, versioned JSON
   cards also live under `.agentx-import/gallery-cards`, outside originals and
   outside the Immich directory. No original or existing XMP is rewritten.
7. Owner review synchronizes only managed review/label tags in Immich. Existing
   human descriptions and unrelated tags remain unchanged. A separate explicit
   frame choice changes membership of the configured frame album.

The original filename and folder grouping are retained where safe, allowing
matching Live Photo names to remain adjacent when their first content references
share a run/folder. Global content deduplication is not a guarantee that every
camera pair is represented as one Immich Live Photo.

## Instance configuration

Core reads `<instance-root>/config/photo-import/processing.json`. No key or model
name belongs in this file. Its SSH identity reaches one NAS forced command and
its known-host file pins that host. `nasHost` identifies the existing physical
resource in Core's heavy-work topology.

```json
{
  "version": 1,
  "sshTarget": "media-user@nas.example",
  "identityFile": "/instance/config/photo-import/collector_ed25519",
  "knownHostsFile": "/instance/config/photo-import/nas_known_hosts",
  "nasHost": "http://nas.example:3180",
  "libraryId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "originalPathPrefix": "/external/phone-imports",
  "frameAlbumId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "autoProcess": false
}
```

The NAS forced command calls the immutable installed product release:

```sh
node /srv/instance/native-tools/photo-import/releases/REV/integrations/photo-import/processing.cjs --config /srv/instance/config/photo-import/receiver.json --ssh forced
```

Only bounded base64 JSON operations are admitted: projection, its status, card
export and bounded import reads. Callers supply identities, never paths or shell
fragments. The receiver configuration and approved duplicate-source mappings
remain operator-owned. This bridge works with the phone host off.

Mount only the managed gallery into Immich, read-only, at `originalPathPrefix`.
Create a dedicated external library with exactly that import path and no other
path or exclusion pattern. Keep its ID and the selected album ID in private instance configuration.
Add the same optional `albumId` to the existing `photo-frame.json`; its trusted
directory continues to work alongside the album. Frame image delivery checks
current membership again, so a removed imported image cannot use an old URL.

Core keeps the existing sole Immich key. In addition to the read permissions in
[photos](PHOTOS.md), processing uses `library.read`, `library.update`, `job.read`,
`tag.create`, `tag.asset`, `album.read`, `albumAsset.create` and
`albumAsset.delete`. Library/album provisioning is an operator action. Description
write enablement is not required. Configure an existing vision-capable `analysis`
route through the normal routing controls; this feature changes no model or pin.

The operator can provision the empty dedicated library and private album from
inside Core with `node scripts/provision-photo-processing.cjs BASE64_JSON`.
The plan contains `operationId`, `libraryName`, `albumName` and
`originalPathPrefix`. Core records each creation fence before its effect and
reconciles lost replies through exact inventory matches. Reuse the original
plan/UUID; an uncertain missing creation is not posted again. Provisioning
uses `user.read`, `library.create` and `album.create` in addition to the above
scopes and starts no scan. Mount the empty managed directory first, then save
the returned IDs in private configuration before enabling processing.

The managed import library is excluded from Core's general family search,
details and thumbnail reads. The explicitly selected frame album can display
chosen images through the frame route. This does not configure Immich's own
sharing or user permissions.

Janitor protects the import ledger, managed references and the content-addressed
`Originals/<prefix>/<SHA-256>` layout; hard-linked references cannot turn their
canonical originals into cleanup candidates.

## API and recovery

`GET /api/phone-media/processing` returns configuration availability only.
The owner-only POST endpoint admits `page`, `enqueueRun`, bounded `enqueue`,
`review` and `frame`. Family/demo restrictions match the phone workbench.
Configuration, file paths, model selection and Immich credentials are never
browser inputs. Cards keep extracted metadata, proposals, review and frame
selection in separate fields.

Whole-import enrollment watches every manifest page without requiring the phone
to stay connected after copying. A pending receipt is revisited; it is never
treated as processed. Content already analyzed reuses its card across imports.
An incomplete USB enumeration still reports its original limited coverage.

Scan dispatch and each model attempt have durable fences before effects. A
restart or lost result retains the original queue/batch/analysis identity and
holds the lane for operator reconciliation. It does not launch a second model
attempt or scan. New heavy effects check the original planned window; upstream
work still active or paused prevents a completion/release claim. USB copies
continue independently during this reconciliation.

Human decisions have stable write IDs and optimistic revisions. Set membership
is reconciled after a lost album/tag response; portable exports reuse the same
version. The server retains the original pending decision so another browser
can resume it. A changed album/library cannot redirect an uncertain choice.

Unit/integration/browser checks use synthetic media and mocked Immich/inference.
Container installation, a real external-library scan, physical phone acceptance
and actual frame delivery are separately verified instance receipts.

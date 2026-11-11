# Android USB photo import

The native importer reads an unlocked Android phone through Windows WPD/MTP.
Core's `photoImportService` owns the import manifest, content identity,
publication and immutable receipts on the configured Media filesystem. The
Windows adapter only discovers objects, transfers bytes and presents results.
It opens WPD with `GENERIC_READ` and resources with `STGM_READ`; it has no phone
delete, move, metadata-write or writable-resource implementation. ADB and USB
debugging are unnecessary.

The importer copies original image/video bytes and XMP/AAE companions without
conversion. App-private and cloud-only originals are outside MTP coverage.
Companions retain their original names and relative paths in receipts; this
step does not yet attach them to Immich assets or rewrite metadata.

## Native Core API

`integrations/photo-import/receiver.cjs --config <host-only.json>` exposes the
versioned `agentx.photo-import/v1` API through the existing SSH identity. There
is no new listener, Immich key, model call or automatic indexing job.

Stdio requests contain one bounded JSON header followed by payload bytes.
Windows uses native SSH/SCP with inherited handles and file envelopes because
Windows OpenSSH can block on Node's redirected stdio. A transport job's UUID
is separate from the persistent domain run/request IDs. `--job UUID` reads
only the configured transport directory; `--cleanup UUID` removes only a
successful job's own transport files. Failed or uncertain jobs are preserved.

| Action | Input | Result |
| --- | --- | --- |
| `begin` | JSON payload: UUID `runId`, hashed `deviceKey`, coverage and `sources` (each with UUID `requestId`, source key, name, path, size and modified marker) | Frozen manifest; same identity with another manifest refuses. Maximum 100,000 media objects / 16 MiB. |
| `lookup` | Header: `runId`, `requestId`, `sha256`, `size` | Reconciled, freshly verified receipt, an exact existing duplicate, or `needsUpload`. The first hash is frozen before effects. |
| `receive` | Same header plus original bytes | Size/hash check, fsync, independent destination readback and atomic publication without replacement; then a durable receipt. |
| `status` | Header: `runId` | Reverified counts of copied, duplicate, pending and failed verification, plus original coverage. A bounded or incomplete inventory remains explicit. |
| `ping` | No payload | Receiver configuration/filesystem availability. |

Run manifests and receipts live under `<root>/.agentx-import/runs`. Originals
live in `<root>/Originals/<hash-prefix>/<full-sha256>/original.<extension>`;
`content.json` records publication identity. Different names with equal bytes
share one original; equal names with different bytes remain distinct. Original
names, paths and each import occurrence remain in the manifest and receipts.
This is an ingestion receipt ledger, not another semantic photo index.

Publication syncs complete private staging directories before renaming them
atomically. Concurrent winners are reverified and never replaced. A crash
after publication but before receipt creation reconciles through the original
request identity. Corruption, missing destinations and changed request hashes
refuse success instead of overwriting or silently declaring a backup complete.

## Instance configuration

The receiver runs on the POSIX host that owns Media. Create the import and
transport roots there before use; absent roots are not created on another disk.
Pin `expectedDevice` to that host's `stat(root).dev` to refuse an unmounted or
different filesystem. Recheck it explicitly after a storage migration/reboot
if the device identity changes. Keep the state/staging subtree outside image
watchers and backups of temporary transport data.

Receiver example (private host file, not a checked-in instance configuration):

```json
{
  "root": "/mnt/photos/imports",
  "expectedDevice": 42,
  "transportRoot": "/srv/instance/photo-import/transport",
  "inventory": {
    "coreUrl": "http://127.0.0.1:3180",
    "mappings": [{ "indexedRoot": "/mnt/media", "physicalRoot": "/mnt/photos" }],
    "maxCandidates": 500
  }
}
```

Core's existing Data Toolbox file API supplies bounded same-size candidates.
The receiver rehashes candidates on approved roots even when indexed hashes
are absent or stale. Backup-role copies are not used as the sole canonical
original. Missing inventory service, excessive candidates and unsafe paths
refuse the decision; no rescan is launched. Files absent from the inventory
remain a coverage gap. Without configured inventory, deduplication covers the
import library only; receipts disclose that scope.

Windows client example:

```json
{
  "cacheRoot": "D:\\PhotoImport\\staging",
  "sshHost": "photo-server",
  "receiver": "/srv/agentx/integrations/photo-import/receiver.cjs",
  "receiverConfig": "/srv/instance/photo-import/receiver.json",
  "remoteTransportRoot": "/srv/instance/photo-import/transport"
}
```

The client needs x64 Windows PowerShell 5.1, Node.js and native OpenSSH/SCP,
with an existing trusted SSH key/known-host entry. `wpd.ps1` compiles the bundled
SDK interface declarations with `Add-Type`; no downloaded COM library or
administrator installation is needed. Choose a staging disk with room for the
largest source file plus temporary interrupted transfers. Nothing schedules
or starts an import when a phone is merely connected.

## Start and resume

Unlock Android and choose USB **File transfer**. Use a data-capable cable;
charging alone does not establish MTP. `start.ps1 -ListDevices` reads WPD
devices, and `start.ps1` selects one (prompting when several are available).
It offers to resume the latest pending local checkpoint before requiring a
connected phone. An instance may create a shortcut to this launcher.

```powershell
.\integrations\photo-import\start.ps1 -Config C:\Instance\photo-import.json
.\integrations\photo-import\start.ps1 -Config C:\Instance\photo-import.json -Resume <run-uuid>
```

Direct CLI: `node integrations/photo-import/import.cjs --config <file>` with
optional `--device <WPD-id>`, `--resume <run-uuid>` and `--limit <count>`.
The default enumeration/selection ceiling is 100,000 objects. A lower limit
is an explicitly partial import, not a complete phone backup. Exit 0 means
the selected run and USB inventory are complete, 2 means incomplete, and 1
means the operation could not establish its result. Inspect the original run
after any lost response instead of creating a replacement import.

Each source is streamed into an exclusive local temporary file. WPD records
size, persistent identity and modification markers before/after reading and
hashes the stream; Node independently rehashes the local spool. Media verifies
the transfer again and independently reads back the destination before a
receipt exists. MTP provides no independent phone checksum: verification is
against the bytes read from its resource stream, and this limit is retained.

Resume preserves manifest/request identities, rechecks receipts on Media and
reuses a verified local spool when available. A phone disconnect during its
read leaves an incomplete file; a network disconnect preserves the verified
spool. Changed phone content needs a new run; it never changes an existing
request's hash. Completed sources in the same run need no new phone read.
The Windows staging lock is a kernel-owned exclusive file handle, released
when its helper exits even if the importer is killed; its filename is not a lease.

Large shared I/O/hash campaigns launched by coding sessions follow the
instance's heavy-work queue and native execution procedure. A small synthetic
fixture or bounded native readback test does not invoke a model. Import does
not grant approval to delete backups, clean the phone, analyze the library,
publish to family or start Immich machine-learning jobs.

## Verification

`node --test integrations/photo-import/test/import.test.cjs` covers interrupted
and oversized streams, same-name conflicts, concurrent exact duplicates,
immutable identities, destination corruption, publication recovery, inventory
bounds/staleness/backup roles, filesystem boundaries, native file envelopes,
and client recovery with a disconnected phone or lost upload acknowledgment.
The suite is included in `scripts/test-native-tools.cjs`.

`node integrations/photo-import/test/native-smoke.cjs <qualification-config>`
uses a separately configured isolated receiver root, synthetic sources and
real SSH/SCP. It checks a lost acknowledgment, resume, a repeated import and
unchanged source bytes. It never opens a phone. Real WPD discovery, media
readback and actual device acceptance remain separate receipts.

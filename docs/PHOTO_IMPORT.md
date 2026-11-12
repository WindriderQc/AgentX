# Android USB photo import

The native importer reads an unlocked Android phone through Windows WPD/MTP.
Core's `photoImportService` owns the import manifest, content identity,
publication and immutable receipts on the configured Media filesystem. The
Windows adapter only discovers objects, transfers bytes and presents results.
The import path opens WPD with `GENERIC_READ` and resources with `STGM_READ`.
The separate [phone workbench](#phone-workbench-in-diskx) implements explicitly
confirmed cleanup through its own writable adapter; import itself never deletes
or changes phone files. ADB and USB debugging are unnecessary.

The importer copies original image/video bytes and XMP/AAE companions without
conversion. App-private and cloud-only originals are outside MTP coverage.
Companions retain their original names and relative paths in receipts; this
step does not yet attach them to Immich assets or rewrite metadata.

## Native Core API

`integrations/photo-import/receiver.cjs --config <host-only.json>` exposes the
versioned `agentx.photo-import/v1` API through the existing SSH identity. There
is no new listener, Immich key, model call or automatic indexing job.

The native receiver and Media ledger continue independently of the Core web
process. Optional cross-library duplicate lookup can use `inventory.dataUrl`
to query Data's own inventory entrance directly, so replacing Core does not
break that read. Legacy `inventory.coreUrl` still uses Core's Data relay;
configure one entrance, never both. Root mappings and fresh candidate hashes
have the same semantics at either entrance. Nothing starts an inventory scan.

Inventory GET requests retry temporary network errors and HTTP 502/503/504
within `inventory.retryWindowMs` (default 30000; maximum 120000; 0 disables
retries). Unavailable inventory remains an error; it never means no duplicates.
The exact original import, cached media and verified receipts stay available
for reconciliation. No phone read or receiver mutation is retried by this GET
policy. Core analysis/indexing is a separate phase from the native copy.

When migrating a running older client, keep its legacy inventory settings
until its worker has finished or the owner has authorized same-ID
reconciliation with the new native release. An existing process retains its
loaded code; replacing a release pointer cannot repair a child already hung
in an old transport. Keep old releases while any worker still uses them.

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
| `lookupMany` | JSON payload: `runId`, up to eight known request/hash/size identities | The same independent Media readback for each item, with per-file errors; no source read or upload. |
| `receive` | Same header plus original bytes | Size/hash check, fsync, independent destination readback and atomic publication without replacement; then a durable receipt. |
| `status` | Header: `runId` | Reverified counts of copied, duplicate, pending and failed verification, plus original coverage. A bounded or incomplete inventory remains explicit. |
| `ping` | No payload | Receiver configuration/filesystem availability. |

File envelopes also accept `batch`: its JSON payload holds the same frozen
`manifest` and `contents` (`requestId`, `size`, `sha256`). Transported originals
are named `<requestId>.media` inside that envelope. Core performs the same
lookup/receive and destination verification for every item; interrupted batches
retain their original IDs and resume through existing receipts. Missing payloads
remain pending. Cleanup refuses an incomplete batch.

Run manifests and receipts live under `<root>/.agentx-import/runs`. Originals
live in `<root>/Originals/<hash-prefix>/<full-sha256>/original.<extension>`;
`content.json` records publication identity. Different names with equal bytes
share one original; equal names with different bytes remain distinct. Original
names, paths and each import occurrence remain in the manifest and receipts.
This is an ingestion receipt ledger, not another semantic photo index.
Verified payloads use readable archive modes (files 0644, directories 0755)
under the operator's access-controlled root, so existing Media share users can
read them. State and occurrence receipts retain private modes. Existing
operator-owned directory permissions are never silently widened on startup.
Core explicitly applies modes after creation because some NAS ACL policies
ignore the requested creation mode; its own private state is sealed on reuse.

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

The WPD reader uses the resource's advertised transfer buffer (64 KiB when
unspecified; values over 16 MiB are refused). Short reads are accumulated;
EOF, the exact declared byte count, source properties and the final hash still
have to agree. A growing or truncated stream never becomes a verified copy.

When an iPhone is exposed through Windows WPD, USB transfer can fail even
after successful enumeration. Keep it unlocked and trust the computer. Apple's
[HEIF/HEVC transfer guidance](https://support.apple.com/116944) places **Keep
Originals** under Settings → Apps → Photos (Settings → Photos on older iOS).
Automatic transfer may convert media on the phone; the importer does not
perform that conversion. A device-unavailable error alone does not establish
its cause. After changing transfer settings, resume the original operation;
if the exposed content changed, the frozen source check refuses it and a new
inventory is necessary. Previously verified Media copies stay intact.

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
Known hashes resume in groups of eight receipt checks, reducing native SSH/SCP
round trips while retaining each destination readback. An unchanged local receipt
needs no redundant checkpoint rewrite. File-envelope SCP retries up to three
times against the same paths; it never repeats the remote domain execution to
compensate for a lost response download. Persistent failure retains the envelope.
Some WPD drivers reissue both object IDs and advertised persistent keys after
reconnection. A pending read can resolve the unique, exact frozen path only
when its name, size and modification marker still match. The stream reader
must confirm that current identity before and after reading. The original
manifest remains unchanged; the first successful read identity is journaled
separately as `readSource` and included in the verified receipt. A changed key
sets `sourceReassociated`. A previously frozen content hash must still match.
Before a first successful read, matching metadata does not prove the bytes
were identical at enumeration time: the backup represents the verified bytes
actually read. Ambiguous paths or changed metadata refuse recovery. Phone
cleanup retains its strict source-key checks and does not inherit this
read-only reassociation rule.
The Windows staging lock is a kernel-owned exclusive file handle, released
when its helper exits even if the importer is killed; its filename is not a lease.
Checkpoint replacement retries brief Windows sharing/access contention for a
bounded period. It preserves the last durable state and complete temporary file
on failure; a retry does not repeat the USB read or upload.
WPD readers also share one kernel-owned lock per device across cache directories.
Inventory, signature audit and copying are serialized; two MTP readers are never
started by the adapter on the same device at once.

Before selection, the signature audit checks unrecognized names and extensionless
objects for JPEG, PNG, GIF, WebP, TIFF, BMP, JPEG XL and common ISO media signatures.
Only 64 prefix bytes are retained; object streams are drained before closing
because some MTP drivers remain busy after an abandoned partial read. Prefix
checkpoints bind the object ID, persistent key, size and modification marker;
failed reads are retried rather than cached as non-images. An unreadable prefix
or an unprobed file keeps coverage incomplete. Signature-selected originals get
the detected archive extension while retaining the original name/provenance.
Their full transferred prefix is checked again at publication.

Native adapters expose `prefixes` and `spool` for bounded bulk transport on one
open WPD reader. They stop after repeated device-unavailable/busy errors, keep
completed local spools and use the same Core lookup/publication contracts.
They do not treat a failed USB read as a duplicate or a completed backup.

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

## Phone workbench in DiskX

`/diskx/phone` is the full-profile phone workbench, linked from DiskX's disk
view. It composes the same Core import ledger, rather than creating another
photo index or gallery. The page detects the configured collector's Android
phones, starts a resumable import, pages existing import occurrences, searches
source folders/names, orders by size, and saves `review`, `keep` or `archive`
choices. The gallery uses clickable previews, a keyboard-navigable modal viewer
and side-by-side comparison of two to four selected media. Comparison changes
no review, frame or phone-cleanup decision. Descriptions and metadata are folded;
reviewed descriptions and generated proposals remain distinct. Page filters
cover photos, videos, exact duplicates, untriaged items and frame suggestions;
counts explicitly refer to the current page of at most 24 occurrences. Bulk
phone-cleanup selection includes only the displayed eligible items.

An exact-duplicate badge means the import reused byte-identical content already
on Media (SHA-256); it is not a deletion recommendation. Similar shots and bursts
are not automatically grouped. Frame suggestions evaluate each image separately,
so similar images may all be suggested. Actual album selection is shown separately
and still requires the explicit frame action. Videos remain outside the frame.
Archiving is a review state; it moves no original. It does not invoke
vision, publish to family, or alter Immich albums.

Core's `/api/phone-media` entrance relays a fixed JSON command to the native
Windows collector through its existing trusted SSH identity. It accepts only
bounded reads and named import/review/cleanup actions; callers cannot supply
an executable, arbitrary path or shell command. Preview bytes come from the
verified occurrence's Media path, are bounded to 8 MiB, and are resized and
re-encoded by Core's existing Sharp dependency. Unsupported formats, very large
images or unavailable codecs display an explicit preview fallback. Indexed
Immich images use Core's larger preview in the viewer; indexed videos use the
credential-private streaming playback route with native browser controls. An
unindexed or unplayable video explains its unavailable state without launching
analysis or conversion. Previews
never become evidence that a backup is still valid. No Windows HTTP listener
or new media credential is introduced. Family-pinned and demo devices do not
have this workbench.

The instance places `config/photo-import/workbench.json` under its existing
`AGENTX_INSTANCE_ROOT`:

```json
{
  "sshTarget": "android-collector",
  "worker": "C:\\AgentX\\photo-import\\integrations\\photo-import\\workbench.cjs",
  "clientConfig": "C:\\Instance\\photo-import.json"
}
```

The client configuration above remains the native import configuration. The
optional `phoneCleanupEnabled: true` enables the separate explicit cleanup
entrance; omission keeps cleanup disabled. Deploy the matching native receiver,
Core photo modules and Windows integration together. Existing run/request IDs,
Media originals and checkpoints remain valid. The receiver needs the `library`
action as well as the original import API. Native `workbench.cjs --config file
--command BASE64_JSON` is the fixed transport entrance, not a shell executor.
A dedicated SSH key can be restricted to the fixed worker with
`--config <trusted-file> --ssh forced`; that entrance decodes only the bounded
`SSH_ORIGINAL_COMMAND` payload and exposes no shell. Configure Core with
`forcedCommand: true`, `identityFile` and a pinned `knownHostsFile` to use it.
Private keys and authorization installation stay outside Git. Its command families are `status`, `devices`, `runs`, `page`, `preview`, `review`,
`prepare`, `cleanupStatus`, `start`, and explicit `reconcile` of an existing job.

The native adapter launches only its own fixed worker. On Windows it uses WMI
process creation with a fixed command line and a private logfile: an ordinary
detached Node child is still killed when its Windows OpenSSH session ends.
The collector account needs permission for this local WMI process creation;
a refusal retains the original launch identity for reconciliation.
Import and cleanup jobs retain their request ID, original input and process
receipt locally; closing the browser or losing SSH does not create another
intent. A lost launch without a process receipt stays uncertain for inspection.
Explicit reconciliation refuses a live original worker and preserves its IDs.

### Selected phone cleanup

Nothing is preselected. The owner selects up to 100 exact imported occurrences,
with at most 2 GiB of source bytes per cleanup batch. Core prepares an immutable
plan only after hashing every selected Media destination. The confirmation
names the files and their estimated logical size, and requires the displayed
`SUPPRIMER N` phrase. A prepared plan, review choice, thumbnail or duplicate
label never executes deletion. The separate library choice and phone choice
remain independent.

After confirmation, the native worker refreshes the same phone's inventory,
resolves persistent source identities and paths, and refuses changed or
ambiguous files. Its separate WPD cleanup module opens a writable session,
fully hashes each selected source, then waits for a just-in-time Core grant.
Core rehashes that file's Media copy before sending the grant. WPD checks the
actual parent/name path and source metadata again and deletes exactly one
file with `PORTABLE_DEVICE_DELETE_NO_RECURSION`. Folders are refused. The import
reader remains read-only and does not load the cleanup module. USB deletion
is direct; the UI does not promise a gallery recycle bin.

The actual WPD PowerShell process owns a global named device mutex and the
legacy exclusive file handle, across SSH/WMI sessions and different staging
folders. A dead Node parent cannot release the native process's device fence.
A kernel-abandoned mutex proves that owner thread ended; it does not settle an
uncertain deletion, which remains independently fenced in the dispatch journal.

Core freezes a claim for each exact device/source/content occurrence. The
native worker retains a durable native attempt ID, bound into the Core grant;
losing/resetting the local cache cannot reuse that grant for a new attempt. The
native worker fsyncs a dispatch record **before** invoking WPD and a result
record only after exact overall and per-object success. Core receives that
native result durably. Lost acknowledgments reconcile the original native
receipt, including with a disconnected phone; a dispatch without a result is
uncertain and is never automatically sent again. A replacement operation for
a held source refuses. Confirmed deletions and unresolved sources appear in
the workbench and cannot be selected again. A later changed file at the same
path is a separate occurrence after its own verified import.

The status counts confirmed deletions and corresponding logical bytes. It
makes no claim about measured physical free space. Copies, original metadata
bytes and import provenance on Media remain intact. Core stores review
versions, plans, claims, grants and results under the existing private import
ledger, not in a runtime's second content database.

Workbench checks:

```sh
node --test integrations/photo-import/test/phone-workbench.test.cjs
node --test core/surfaces/diskx/test/phone.test.js
node core/tests/browser/phoneWorkbenchJourney.cjs
```

The browser journey uses synthetic media and a fake native adapter, checks
mobile layout and exercises lost-result confirmation without a repeated
effect. SDK compilation, Windows job/SSH transport, and real-device deletion
acceptance are separate checks. A successful compile or simulated deletion
is never a real-phone deletion receipt.

An incomplete import exposes its first source failure alongside the verified
counter and original request identity. The Windows-only
`test/stream-smoke.ps1` regression uses a synthetic size-limited `IStream` to
verify driver-sized buffers, partial reads, hashing, rejected growth/truncation
and no overwrite; it opens no physical phone.

On Windows, `powershell -NoProfile -STA -ExecutionPolicy Bypass -File integrations/photo-import/test/lock-smoke.ps1` compiles the SDK and checks both reader and cleanup fences with a synthetic device ID. It verifies the named mutex across different TEMP directories without opening a real phone.

The headless WMI launcher redirects its worker's input to NUL. Fixed SSH
envelope commands use `-n`; SCP keeps its own SSH/SFTP stdin protocol. Stderr
and stdout still inherit native handles rather than Windows child-process
pipes. Staging setup is bounded to 30 seconds; other file-transport children
are bounded to 30 minutes. A transport timeout preserves the original domain
identity and files; it is not proof that the receiver effect did not happen.

`test/file-transport-smoke.cjs` runs through `launchWorker` on Windows with a
disposable receiver configuration and `--config <file> --run <UUID>`. It
records exclusive qualification intent, executes twelve actual file-envelope
pings and writes a terminal result under the private cache after SSH logout.
It does not open a phone. Inspect the original intent/process/result after a
lost qualification response rather than launching a replacement blindly.


## Windows reconnect identity recovery

A Windows USB reconnect can replace the WPD device identifier. Normal resume
keeps the original device key and refuses a different selected device. An
operator can recover read-only import access after the owner identifies the
connected device as the same phone:

```sh
node integrations/photo-import/reconnect.cjs --config /absolute/client.json --command <base64-json>
```

The JSON request contains `operationId`, `runId`, the detected `deviceId` and
`samePhone: true`. Plan the phone inventory and sample reads in the normal
heavy-work window before invoking this operator capability. It takes the same
workbench/import locks, requires a complete inventory with unique unchanged
facts for every still-needed source, and independently hashes three distinct
previously verified contents read from the selected phone. Their canonical
Media copies are first rehashed through the receiver. Each anchor is at
most 16 MiB. Missing/ambiguous/changed sources, insufficient anchors and a hash
mismatch refuse recovery.

The immutable receipt lives under the local staging root in
`source-bindings/<runId>/<operationId>/binding.json`. It binds the original
manifest fingerprint to the observed device. The next normal resume uses it
without changing the original run, selected source facts, device key or Media
receipts. Replaying the same recovery identity returns that proof; it does not
repeat successful phone reads. This binding never changes cleanup's strict
physical-device/key checks or supplies deletion authorization.

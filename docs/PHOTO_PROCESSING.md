# Verified phone media processing

DiskX composes verified USB imports, Core analysis, Immich and owner review.
The copy worker remains independent: it never waits for an inference, Immich
scan or Core deployment. A phone stays read-only until the owner uses its
separate selected-cleanup confirmation.

## Flow and ownership

### Global owner photothèque

The Personal menu and DiskX link `/diskx/photos`, which browses completed image proposals from the configured managed
library across all imports, one entry per content SHA-256. Search, review,
privacy, frame and quality filters apply in Mongo before bounded 60-card
pagination. Counts describe photos in the entire eligible collection before filters.
Suggestions require a positive model proposal, good technical quality, no privacy
review flag and no prior frame rejection. A conservative text gate excludes
proposals describing documents, paper sheets, screenshots or cover art; it does
not reclassify the original analysis or treat OCR alone as document evidence.
These gates reduce obvious mistakes without guaranteeing editorial suitability.
Already selected images stay in the frame view. Failed or
unknown attempts, videos and metadata-only cards remain in the import workbench.
Ordering has a deterministic content-identity tie breaker. The owner-only
`POST /api/phone-media/processing` operation `library` returns only the current
proposal, extracted facts, human choices and bounded pending-decision intent,
without historical analysis or internal reconciliation journals.

The UI retains filters in its URL, supports a page jump, comfortable/compact
layouts, a large keyboard-accessible viewer and up to four comparison choices
across pages. Each card exposes **Ajouter au Cadre**, or removal when selected,
and **Écarter cette photo**. Rejection records an explicit false frame decision;
the photo remains in all images and can be selected again. It does not approve
metadata or reject its entire similar-image group. Human review and frame changes reuse the existing version-checked
decision services and portable exports. Unacknowledged browser or Core intents
remain visible and reuse their original identity; other decisions stay disabled
until reconciliation. Unsaved description edits require confirmation before
leaving the viewer. Comparisons alone write no decision.

The optional `similarity: "grouped"` view presents one representative per close
visual group, after filters and before pagination; `similarity: "all"` retains
every image. Suggestions default to grouped, other views to individual photos.
`group` opens one SHA-256 group identifier without collapsing its matching
members. Group counts and matching photo counts remain separate; overview
counters always count photos. Group representatives use the requested stable
sort, not an aesthetic ranking. Search can reveal a different member of a group.

Core's replaceable `PhotoLibrarySimilarity` index binds each member to its
content SHA and exact current Immich asset ID. Missing or stale entries remain
individual photos, with coverage visible. The operator-only command
`core/scripts/photo-library-similarity.cjs` reads bounded existing previews,
computes pHash/dHash plus colour and aspect checks, and atomically publishes one
library-scoped index. It takes `{ operationId, queueId, dispatchId }` on stdin
inside Core's configured environment and checks the existing operator queue
dispatch/window before reads and publication. It never resumes processing,
scans Immich, calls inference or changes a card, original, frame choice or review.
At most 10,000 eligible cards are accepted per operation. Interrupted builds
leave the prior index visible; the same completed operation returns its index.
Similarities are indicative and require complete-link membership to avoid
transitive chains. No group authorizes deleting or selecting its members.

Both media entries show the durable photo control, including unknown reads and
already admitted writers. Browsing never enrolls an import, scans Immich, resumes
processing or invokes inference. The import's enqueue button is disabled while
paused or control status is unavailable. Review and frame choices remain usable
while paused. Garder/Archiver remain occurrence-level labels in the original
import workbench, linked from the global detail view; neither moves originals.

### Import processing

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
   outside the Immich directory. No original or backed-up XMP is rewritten.
7. Owner review synchronizes only managed review/label tags in Immich. Existing
   human descriptions and unrelated tags remain unchanged. A separate explicit
   frame choice changes membership of the configured frame album.

### Durable tags in a read-only Immich library

Before changing tag membership, Core asks the NAS to persist a complete tag set
in an AgentX-owned XMP beside the **gallery reference**. This is a separate
regular file, never another link to original media or a backed-up companion.
The gallery stays mounted read-only in Immich. This lets later metadata
extraction read the intended tags even when Immich cannot write a sidecar.
See [Immich's XMP behavior](https://docs.immich.app/features/xmp-sidecars/).

The NAS retains an immutable write intent and monotonic owner-review revision,
atomically publishes the sidecar and checks its bytes. An unknown XMP, edited
sidecar, symlink or hardlink refuses. A lost writer lock requires observation;
it is never removed by age alone. Replays use the same write ID and tag set.
A pending marker cannot replace a newer owner review. Original unrelated tags
are merged with the managed labels; incomplete historical snapshots refuse
rather than silently truncating human tags. No description, date or other
human field is placed in this tags-only XMP.

Core waits for sidecar/extraction jobs to settle and reads tag membership back
before acknowledging synchronization. A missing tag or unavailable extraction
remains a reconciliation error. Use DiskX for durable managed review; direct
Immich metadata edits retain Immich's own read-only sidecar limitation.

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
export, versioned gallery tag sidecars and bounded import reads. Callers supply identities, never paths or shell
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

### Explicit retry after a verified admission refusal

`core/scripts/retry-photo-analysis.cjs` creates one operator-owned attempt for
an image whose previous result is explicitly `not-attempted` after a reconciled
`RUNTIME_INFERENCE_ADMISSION_DENIED` before provider dispatch. It refuses ordinary
failed proposals, unknown outcomes, active claims and changed evidence. Enqueueing
the same sources still reuses existing results; it does not implicitly retry them.

An execution plan binds `operationId`, new `analysisId`, `previousAnalysisId`,
`reconciliationId`, content `sha256`, `previousAnalysisSha256`, `configHash`,
`targetHash`, `queueId`, `dispatchId`, `receiptRef` and the explicit confirmation
`RETRY_VERIFIED_NOT_ATTEMPTED`. Hashes are SHA-256 of the corresponding JSON
value: previous analysis, `[libraryId, originalPathPrefix, nasHost]`, and the
existing routed `{model, host}`. Clients do not configure a different model.

Before execution, plan a diagnostic operator window in Core's heavy-work queue
with key `photo-analysis-retry:<operationId>`, the existing NAS and analysis
hosts, and the same private receipt path. Wait for the active batch to finish
naturally, reserve and begin that exact request through the native operator.
The script requires its dispatch identity and at least four minutes remaining.
Pass the reviewed plan as base64 JSON in `PHOTO_ANALYSIS_RETRY`, then run the
script from Core's application directory. A reviewed standalone operator artifact
can use `PHOTO_ANALYSIS_RETRY_STDIN=1`; this does not patch or restart the server.

The existing full-batch writer excludes concurrent photo work and maintenance.
The script rechecks the verified projection and exact Immich asset, takes the
existing decoded preview and calls Core's analysis capability once. It preserves
the complete previous analysis under `analysis.retry.previousAnalysis`; the old
portable card stays immutable. The new card uses a new analysis identity and
records `retryOf`. EXIF facts, model proposals and human review/frame choices
remain separate. No original or owner decision is rewritten.

A repeated completed request reads its existing result without another model
call. A lost claim, provider or export response retains the exact attempt and
an unknown writer fence; neither elapsed time nor a repeated command permits
another inference. A malformed but completed response becomes a failed new
card, without automatic retry. Completion requires portable export, settled
indexing and release of that attempt's writer. The operator then records its
native queue receipt and verifies the photo control retains the owner’s chosen
state. A paused control refuses retry admission too: any temporary opening needs
explicit owner authorization, and a requested pause is restored before closing
the operator window. Completion never authorizes a broader FIFO restart.

### Pausing new photo processing

An owner can explicitly reconcile one or two unfinished images **without
resuming general processing** with
`core/scripts/reconcile-selected-photo-analyses.cjs`. Its stdin plan names
`operationId`, `queueId`, `dispatchId`, `configHash`, `targetHash`,
`controlRevision`, `controlRequestId`, `receiptRef`, the confirmation
`ANALYZE_ONLY_SELECTED_IMAGES_WHILE_PAUSED`, and at most two `items`. Each item
binds `sha256`, a new `analysisId`, `previousAnalysisId` (null for a first
attempt) and `previousAnalysisSha256` (the digest of null when absent).
Eligible content has no prior analysis, or an exactly identified completed
invalid proposal (`failed` / `PHOTO_ANALYSIS_INVALID`); running, unknown,
successful and other failed attempts refuse.

The diagnostic operator queue key is `photo-analysis-reconcile:<operationId>`.
Its hosts are the current NAS and routed analysis endpoints; its exact receipt,
dispatch and window must match. The native writer checks a persisted selected
batch and the unchanged pause receipt at the same CAS boundary as maintenance.
Normal FIFO admission stays closed throughout, including after a restart or
when another worker races the selected attempt. Each model dispatch rechecks
the pause, window, original reference and exact Immich asset. Facts, human
reviews and frame decisions stay unchanged; previous analyses are retained
under the new attempt's history, and new cards are exported immutably.
An uncertain claim, provider call, export or release keeps that exact writer
fenced for observation. A completed invocation reads back its receipt without
another model call. There is no automatic retry, scan or general resume.

Historical failed batches retain their original outcomes and release receipts.
Audit their occurrences against current import receipts, current content cards
and queued occurrence identities before deciding what remains. An old partial
progress count does not establish current coverage. Missing occurrences can be
explicitly enrolled for later processing while the pause remains in force;
enrollment does not replay their old failed operation.

The owner pauses photo admission through the existing queue operator:

```sh
agentx-work-queue photo-status
agentx-work-queue photo-pause --actor operator --id REQUEST_UUID --revision CURRENT_REVISION
```

`--id` identifies this control intent, not a batch or queue request. Read the
current revision first and retain the same identity and arguments after a lost
reply. `photo-status` reports the latest control receipt and any admitted photo
writers; an uncertain response is a reason to observe, not launch again.

The control is stored on Core's existing runtime coordination document, beside
the photo writer fence. It has no expiry or scheduled resume and survives Core
restart. Its admission check and writer acquisition share one atomic boundary.
Paused processing skips discovery and new claims. Existing admitted work can
finish; native observation and exact release remain available. An UNKNOWN writer
keeps its original fence and needs its original reconciliation. Pause never
cancels a batch or a queue request and never clears an active writer.

Configuration remains present: the managed library's family exclusions, photo
reads, review and frame choices retain their existing permissions. Public GET
still returns configuration availability only. The existing owner-only POST
adds `control`, `pause` and `resume`; control writes accept only a request UUID,
an expected revision, and the explicit confirmation required for resume.

Resuming requires `photo-resume` with a new control request UUID, the fresh
revision and `--confirmation RESUME_PHOTO_PROCESSING`. It opens admission;
native queue windows and resource checks still apply. Retained future
reservations do not start work while paused. If an old reservation expires,
move that same request through the native queue before a supervised restart.
Selecting a later night window is a separate owner decision, never an automatic
consequence of pausing or elapsed time.

For the first installation, a reviewed copy of this same owner implementation
can stage the control on the existing runtime document with a legacy model.
That stored value is not enforced by an older Core: retain the native FIFO hold
and bounded maintenance drain until the reviewed Core revision is installed.
Verify the original control identity and paused state after the new process
starts. Do not replace the shared configuration or remove library exclusions
to imitate a pause.

### Draining before Core maintenance

Core records a durable batch writer in the runtime coordination document
before claiming a photo worker slot or crossing the queue dispatch fence.
Maintenance acquisition and writer admission exclude each other in that same
Mongo compare-and-set. The writer covers projection, indexing, the gaps between
image calls, metadata cards and portable export. It changes no inference,
Benchmark or Profiler admission.

The Bash launcher requests the existing bounded runtime drain when its only
blockers are active photo writers and drainable background inference. Core's
photo monitor stops admitting batches during that drain; an already admitted
batch continues normally. The writer releases only after the native batch is
completed and Immich indexing is settled. The maintenance lease then keeps new
batches out across the recreate, even when process-local drain advice clears.
After lease release, the monitor resumes the existing FIFO and reuses completed
content cards. A drain timeout withdraws the advice and refuses maintenance;
it never terminates a batch.

An unstarted validation/reservation refusal releases only its own writer and
leaves the selection queued. A lost begin response, unknown model/scan/export
outcome or process crash retains the original identity and durable fence.
Neither elapsed time nor a terminal queue alone clears that fence. Completed
batches with settled indexing can be observed after a restart; uncertain effects
require native reconciliation. Runtime coordination lists the writer without
its process proof and names it in deployment blockers. Unknown writers also
raise the existing runtime quarantine alert.

For the first installation on a version without this protocol, its drain
endpoint does not protect photo batches. Through the existing queue operator,
observe the active batch's natural completion, queue release and settled
indexing. Active work prevents even a future reservation on the same resources.
At that boundary, reserve the earliest unstarted FIFO photo request in a future
window, preserving its identity and selection with the current queue revision.
If the monitor starts another batch first, the reservation refuses: observe that
batch and wait for its natural boundary instead. After a lost reservation reply,
read the same request before any retry. Verify the held request remains unstarted,
later requests stay behind it and no photo worker still owns a claimed/running
slot, then deploy through the ordinary maintenance gate.
Keep the future FIFO reservation in place until the new Core is verified; move
that same reservation back through the native operator to resume processing.
If any identity or launch is uncertain, stop the installation and observe it.

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
For a proven `RUNTIME_INFERENCE_ADMISSION_DENIED` before provider dispatch,
Core's operator `scripts/reconcile-photo-admission.cjs` can close the exact
running claim as a failed, **not-attempted** metadata card. It requires the
original batch/dispatch/analysis identities, operator evidence that the old
worker terminated, no overlapping runtime authority and settled indexing.
The same recovery ID is idempotent; timeouts, possibly dispatched calls and
other errors refuse. This performs no inference and changes no human decision.
Supply the reviewed plan as base64 `PHOTO_ADMISSION_RECOVERY`, from Core's
working directory. An operator delivering the reviewed script through stdin
also sets `PHOTO_ADMISSION_RECOVERY_STDIN=1`; it runs in a separate Core-side
process and changes no loaded server module. The queue's original dispatch
is reconciled separately through the native queue operator and its receipt.

Container installation, a real external-library scan, physical phone acceptance
and actual frame delivery are separately verified instance receipts.

## Private registry export

The [portable registry export](PHOTO_PORTABLE_REGISTRY.md) reads the existing
card and decision collections for an explicit private operator selection.
It starts no processing and is not a relocation or complete backup.

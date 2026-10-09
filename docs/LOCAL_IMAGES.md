# Local image generation and editing

The full profile serves `/images` and `/api/images`. Core owns the requests,
GPU reservation, recovery journal and archived results. ComfyUI executes a
server-owned workflow on a local worker. The service is disabled until an
external worker manifest and `IMAGE_ARCHIVE_DIR` are configured.

One request can create an image or edit up to two PNG/JPEG references. The
browser offers a prompt, qualified profiles, resolution, progress, cancellation
and the original output. A generated image is decoded, checked against the
pixel budget, archived and hashed before Core returns an artifact URL. The
configured archive may be part of the household photo library. Human studio
access follows the deployment's trusted LAN boundary; native agents retain
their separate permission policies.

The optional imageX panel integrates Hermes into the Atelier: chat, editable
prompt proposals, operational events, routing facts and read-only profile files.
Core retains the canonical `image-workshop` conversation and keeps gateway
credentials server-side. The panel sends text and current recipe evidence;
reference images remain on the local rendering path. Apply a proposal explicitly
before creating an image. A changed draft context blocks stale application.
Completed proposals can be attached to an image request by session/turn identity;
Core resolves that identity from its conversation store before any worker action.
Details and recipe exports retain this collaboration receipt and record prompt
or setting changes. Restarted consultations are interrupted without inference
replay. The manual creation path remains usable without Hermes. Installation and
protocol details are in [the Hermes adapter](../integrations/hermes/README.md).

Nestor and Famille display conversation image cards with read-only progress,
verified output and a **Continuer dans l’atelier** link. The atelier restores
the selected operation's brief, seed and supported format/profile. **Utiliser
cette image comme référence** selects the archived original as the first parent
reference. The browser sends `{parent: {operationId, sha256}}`, rather than a
JPEG preview. Core requires a completed operation with restored runtime, checks
the archive bytes and declared SHA, and refuses an original above the existing
4 MP reference limit or 8:1 ratio before contacting the worker. In conversation
requests, the parent must belong to the same surface, session, pack and scope;
the trusted LAN atelier retains its existing archive access. At most one uploaded
file may accompany a parent. Uploaded files keep their browser working-copy path.
The original archive remains intact. A new model or prompt
does not guarantee preservation of the previous composition.

The workshop separates composing, inspecting a result and browsing the recent
library. Opening a library image changes only the preview. Reusing its brief
and attaching it as an editing reference are explicit, independent actions.
Conversation continuation links still restore the saved draft, with its origin
shown. A plain visit starts with an empty preview; an active or uncertain
operation resumes observation instead of starting another calculation.

Read-only `GET /api/images/workshop` reports the configured worker, model
components, step count and pixel budgets. `GET /api/images/operations/:id/details`
reports that operation's saved recipe and request, actual archived dimensions
and recorded total time. Historical recipes do not inherit the current profile's
step count. A different historical worker never inherits the current GPU label.

New reference operations retain `lineage.version: 1` and ordered source/worker
SHA descriptors. When a parent is chosen, they also retain its operation ID,
original SHA and dimensions. The parent comes first, followed by the uploaded reference. The
`decoded-pixels-to-png-v1` transformation identifies the existing metadata-free
PNG normalization; it is distinct from the archived original. Legacy worker
buffers may be removed after a known terminal outcome while these descriptors remain.
The details view links to the recorded parent, independently of current profiles.
Older operations without lineage remain without it. Parent identity, SHA and
transformation version participate in request identity: changing the parent
under an existing action key returns 409, including when two parents have the
same bytes. An exact replay returns the existing operation before reading the
parent archive or contacting a worker. This lineage does not constitute a full
recipe export or HQ/finish16 execution contract.

New reference operations archive both the source bytes received by Core and
the exact normalized PNG bytes prepared for the worker. A browser JPEG working
copy is the received source, not a claim to preserve the user's original file.
A parent may reuse its verified original archive receipt. Mongo stores a private
`referenceStorage.version: 1` with ordered source/worker receipts and dimensions,
linked to the retained lineage hashes, instead of image buffers. These receipts
and archive paths are excluded from ordinary queries and public details. They
survive known terminal outcomes and recovery alongside lineage and execution.

An identical replay returns before reference archive reads or writes. For a new
action, Core stores and reads back the references before contacting the worker.
The executor then reloads their actual persistent receipts, compares them with
the accepted reference contract and verifies source/worker hashes, dimensions,
order and PNG worker encoding before reservation, upload or submission. A missing,
corrupt or incoherent reference fails explicitly. A declared invalid storage
record never falls back to legacy buffers. Existing operations can still read
their valid legacy buffers; recovery observes the original job without reuploading
or renormalizing references.

The shared archive reader accepts canonical relative paths and bounded regular
files, checks size, MIME and SHA, rejects static symlinks beneath the configured
root and reads through a stable handle with identity checks before and after.
The configured root remains a trusted boundary and may be a filesystem alias.
Archive writes also refuse static symlinks in child directories, image files and
sidecars. This does not promise isolation against a hostile operator replacing
directories concurrently. Cancellation, offline refusal or an acceptance race
may leave legitimate content-addressed images and sidecars; this change adds no
garbage collection, shared-blob deletion, power-loss durability or complete export
contract. Reference decoding and request limits remain unchanged.

A profile may declare an optional `recipe: {"id": "studio-edit", "version": "1"}`
in the existing private worker manifest. This declaration contains exactly those
two strings, each 1–80 letters/digits or `._:-`, beginning with a letter/digit.
It names the current server-owned Klein/Qwen workflow; it supplies no nodes,
code, new parameters or weight provenance. It is distinct from a lab catalogue
record or graph hash, and proves no installed model digest or global recipe
immutability. Profiles without a declaration keep their existing behavior.

The workshop reports the declared identity and sends optional `recipeId` and
`recipeVersion` together. A partial or malformed pair is 400. For a new action,
an undeclared or mismatching expected recipe is 409 before reading a parent or
contacting a worker. The pair participates in request identity; changing it
under the same action key is 409. An identical accepted replay is returned
before comparison with the current declaration, so a v1 operation remains
observable after the profile moves to v2. Callers without the pair preserve
their previous request hashes and may use the current profile.
The existing checks still require that profile and requested dimensions to be
valid. An invalid recipe declaration makes the manifest unavailable, just as
an invalid profile does; declare versions as strings.

After reference uploads return their actual names, Core constructs the graph
once and awaits durable storage of `execution.version: 1`, builder ID/version,
the exact JSON and its `graphSha256` before submission. It submits that same
graph when dispatch proceeds. Snapshot persistence failure prevents submission.
Core also compares the returned stored graph and digest with the prepared SHA
before dispatch, refusing a missing or changed snapshot after an acknowledged
write. Existing restoration and quarantine contracts still apply. Execution snapshots
survive terminal reference-buffer removal and recovery. Width and height in
`execution.parameters` are the requested format; Qwen's effective resolution
and latent path are recorded in the graph, not inferred from those dimensions.

Details disclose only snapshot version, builder, graph SHA and the already
public width/height/seed/steps, plus the historical declared recipe identity.
They never expose the stored graph, additional brief copies or private manifest
properties. The UI labels its digest **Graphe préparé**: a locally stored graph
and `dispatchStarted` intent do not prove backend receipt or execution. The
submission response and terminal operation state retain their existing meaning.
Older operations without execution or a declared recipe remain without them;
details never synthesize either from today's profile. Recipe/catalogue graph
SHA, submitted JSON SHA, uploaded-reference SHA and verified output SHA describe
different artifacts. No HQ, finish16 or complete recipe export is enabled here.

`/images/guide` (linked from the atelier header) explains the path of a request,
lists the installed recipes and gives prompting advice. Its host, GPU and recipe
facts come from `GET /api/images/workshop`; the page source names no machine or
model, so it stays true when the worker or the profiles change.

`/images/labo` serves the workshop's trial site read-only: comparisons with a
side-by-side viewer, the hosts and measured setups, recipes, the plan, and the
older gallery, journal and manual. Its pages, scripts and styles are in
`core/public/image-lab`; its images, evidence files and frozen API answers are
read from `<IMAGE_ARCHIVE_DIR>/atelier-site`. Host occupancy is computed live
from runtime coordination. Nothing in it starts a generation or a reservation.

New trial results reach the lab through the shared drive, not through a
development host: a session deposits a folder under
`<IMAGE_ARCHIVE_DIR>/atelier-tests/` with its images and a `lot.json` record
(schema `agentx-image-lot-record-v1`: per image the file, hash, dimensions,
brief, recipe, seed, timings, measurements, and the owner's words when given).
Each trial of each lot appears as a comparison at the next request.
Neither read endpoint initializes recovery, starts a worker or takes a GPU claim.
The current worker's optional external `presentation` object provides
`hostLabel`, `gpuLabel` and `vramGiB`; these are configured inventory, not live
telemetry. Profiles may provide `presentation.description`. No speed or quality
ranking is inferred from a label or a step count. The operation's total time
includes preparation, computation, archiving and restoration; its receipt does
not measure these phases separately. The library currently reads the latest
30 operations, rather than the complete external photo archive.

## Configure a worker

Run a qualified ComfyUI version outside the AgentX checkout. The client uses
the v0.38.0 prompt identity, job-scoped cancellation, history and memory APIs.
Install only the model files the selected profile requires. Record their source
revision, digest and license in the private instance manifest or receipt.
Do not import unreviewed custom nodes or API nodes for this service.

Use a dedicated worker that only Core submits to. Disable API nodes and saved
prompt metadata. Keep it on loopback or a private container bridge reachable
by Core; do not publish the ComfyUI UI or submit prompts manually while Core
owns the worker. On hosts sharing RAM with other services, qualify the cache
and offload policy with those services present.

When the worker runs on another host than Core, it has to listen on that
host's LAN address. Pass `--allow-client <address>` for Core's source address
(repeat it for several): the supervisor then answers 403 to every other
caller, reads included. Without the option, every caller that reaches the bind
address is accepted, which is only suitable for loopback or a private bridge.

`integrations/local-images/worker.py` is a CPU supervisor for that installation.
Run it with the ComfyUI root, its virtual-environment Python, an external state
directory and the `/object_info` schema captured from the pinned installation.
The supervisor listens privately; its CUDA child listens only on loopback.
It starts that child for computation and `/free` waits for its process exit,
releasing the CUDA context as well as model allocations. This matters when a
small remaining CUDA reservation changes Ollama's full-GPU placement decision.
Terminal execution receipts survive child recreation; the adapter never replays
a submitted identity. Core still owns operation state, recovery and archiving.

Set `LOCAL_IMAGES_CONFIG` to the manifest path **inside Core**, and mount that
file read-only through the instance Compose override. Set `IMAGE_ARCHIVE_DIR`
to writable external storage. A minimal manifest is:

```json
{
  "workerUrl": "http://127.0.0.1:8188",
  "ollamaHosts": ["http://127.0.0.1:11434"],
  "defaultProfile": "klein",
  "conversationProfile": "klein",
  "timeoutMs": 900000,
  "drainMs": 60000,
  "profiles": {
    "klein": {
      "label": "FLUX.2 klein 4B",
      "family": "klein",
      "diffusion": "flux-2-klein-4b.safetensors",
      "encoder": "qwen_3_4b.safetensors",
      "vae": "flux2-vae.safetensors",
      "weightDtype": "fp8_e4m3fn",
      "steps": 4,
      "maxPixels": 1048576,
      "license": "Apache-2.0"
    }
  }
}
```

Container loopback is the container itself. Select a bridge or LAN address
when the worker is native on another host. Endpoints accept explicit private
IP addresses or localhost; public URLs and URL credentials are refused.
`conversationProfile` optionally selects a qualified `klein` profile with at
most eight steps. Otherwise the first such configured profile is selected.
Conversation drawings use a square of at most 1024 pixels per side, reduced
to the profile's pixel budget in multiples of 32. This preset needs local
quality/latency qualification; its presence is not a speed guarantee. Without
a quick profile, bounded conversation drawings are unavailable; family never
implicitly switches to the studio's quality default.
`ollamaHosts` must name **every managed endpoint consuming the image GPU**,
using the same endpoint identities as Core inference. The optional
[`AGENTX_RUNTIME_RESOURCES_JSON` map](OPERATIONS.md#physical-gpu-admission)
also fences Core consumers on configured physical GPU aliases. It does not
discover devices or stop games, voice workers or other unmanaged consumers.

The `qwen21` family uses Qwen-Image-2.1 ConvRot INT8 diffusion and encoder
files, its own VAE, Euler/simple sampling and lossless CPU prefix caching.
Its license is research/evaluation: label that profile explicitly. Enable
only the resolution and step budget qualified on the actual host. References
are decoded, bounded to an 8:1 aspect ratio, and their editing pixel budget is explicit; a large source photo
does not silently create a 12 MP render. The browser prepares smaller JPEG
copies for uploaded files; a chosen archived parent uses the verified original.
Qwen editing follows the first reference's framing at the
selected pixel budget, with a margin for its 32-pixel rounding.
It preserves the generated output at full
quality; upload originals remain the conversation attachment capability's job.

## Request and recovery contract

`POST /api/images/operations` requires `actionKey`, `prompt`, optional `profile`,
`width`, `height`, `seed` and a `references` array of at most two base64 images.
An optional `parent: {operationId, sha256}` selects an archived original as
reference zero. It counts toward the two-reference limit, leaving room for
one uploaded reference. Core verifies this parent before worker readiness.
Dimensions must be multiples of 32, from 256 up to the family's widest edge
(2048 for `klein`, 2752 for `qwen21`), under the profile's pixel limit.
Use a fresh action key for an explicit new variation. Replaying the same key
and input returns its existing operation; changed input returns 409.

Accepted requests return 202 immediately. `GET /api/images/operations/:id`
reports progress; `.../:id/image` serves the verified archive. Core reserves
the bound worker endpoint and configured Ollama consumers, records the exact resident snapshot before mutation,
unloads them, computes, releases worker memory, and restores the original
digests, contexts, lifetime policy and GPU placement before marking completion.
It does not edit benchmarked Modelfiles or context settings.

An offline worker is refused immediately. A busy GPU has only the bounded
admission/drain window; expiration requires a new explicit request. There is
no dormant queue waiting for a computer to return. Only one operation owns a
worker slot. A restart marks unfinished operations `unknown` and never retries
the prompt. Unknown outcomes retain the GPU recovery fence.

`POST .../:id/cancel` records cancellation and the executor uses job-scoped
cancellation. Acknowledgement is not terminal proof: Core observes the original
history before restoring. `POST .../:id/archive` retries only output import
after an archive failure; it never calculates another image. `POST .../:id/recover`
adopts an expired recovery lease only when the original image job is proven
terminal, then restores and imports its original result. A pre-generation
mutation with an uncertain outcome requires native operator reconciliation;
an empty queue, timeout or HTTP 404 never clears that fence.

The native `local_image` tool is optional and available only to the private
owner through the Nestor harness. It returns a durable operation and studio
link. Nestor ends that turn to release its LLM reservation on a shared GPU;
status in a later turn can return the archived image. It does not block the
same agent loop waiting for its own GPU or silently use a cloud provider.
This asynchronous tool does not promise automatic completed-image delivery
to Telegram.

Household retains the accepted create's exact Core action identity in its
native run evidence. Once the native turn settles, the private owner receives
the operation's current Core state and its studio link through the existing
spoken/display channels, including after a conversation fallback or terminal
model failure. The native attempt remains in the audit; its text cannot cancel
an accepted image. This receipt observation neither generates another image nor
grants tools to a fallback model. A later status reads the same verified artifact.

## Historical recipe downloads

The atelier offers an explicit **Exporter la recette et ses images** action for
a completed operation whose runtime has been restored. Preparing the downloads
checks its persisted execution and every archived image. The manifest contains
the stored brief, requested dimensions/seed, historical profile and optional
declared recipe identity, builder identity, graph SHA-256, ordered lineage and
file descriptors. The brief and reference images may be personal; the atelier
discloses this before the user prepares or shares the downloads.
Source originals retain their embedded metadata, including EXIF/GPS when
present; only the recorded worker PNG was normalized during acceptance.

`GET /api/images/operations/:id/export` downloads a version-1 JSON manifest.
`GET /api/images/operations/:id/export/parts/:name` downloads `graph.json`,
`output.png` (or `.jpg`) and the recorded `reference-0/1-source.png` (or `.jpg`)
and `reference-0/1-worker.png` pieces. Filenames are enumerated from the operation;
clients cannot supply archive paths. Responses use attachment disposition,
`private, no-store` and `nosniff`. They retain the existing human LAN atelier
authority and are not automatically exposed by conversation adapters.

The graph is the exact stored `JSON.stringify(graph)` byte sequence, verified
against its durable SHA. A frozen verifier accepts only the closed topology and
fields of known builder v1 Klein/Qwen graphs, bound to the recorded parameters,
model filenames, reference order and operation ID. It never replaces a missing
graph with the current workflow or profile. Each request verifies the recorded
images' SHA, size, MIME and decoded dimensions and rechecks the Mongo snapshot
before responding; no previous verification is cached. Host configuration,
worker URLs, conversation identities, admission proofs and archive paths are
excluded from the download projection.
The export contract requires string model filenames and a scalar `weightDtype`
token of 1–80 ASCII letters/digits/underscores/dots/hyphens (or the recorded
default). Historical values outside that closed shape are refused without
rewriting the graph or retaining its SHA for altered data.

Unknown/active/unrestored operations return 409 before reading archives. Legacy
operations without a full execution or retained references remain unavailable;
missing/corrupt recorded pieces return 503. Downloading does not initialize the
image service, create indexes, mutate operations, recover a worker, regenerate,
reserve resources or write archives. There is no ZIP, import or graph replay.
Model filenames are historical declarations, not weight hashes or backend
version qualification, and old upload names do not make the graph portable.
Native storage performance, GPU output and device acceptance are separate checks.

## Conversation drawings

For Nestor's private native Household session, the plugin creates through
`POST /api/voice-personas/private/sessions/:sessionId/images`. Core resolves
the actual session and binds its surface, session, pack and scope before
dispatch. Without an explicit profile, the quick conversation preset applies.
Telegram keeps the existing global operation path and studio delivery contract.

Famille and personal Core/Ollama conversations can request one new drawing
with `<show kind="image" source="draw" title="caption">description</show>`.
Household processes it only after conversation execution releases its LLM
reservation, applies family drawing restrictions, and supplies fixed quick
parameters. Family has no arbitrary generation POST, uploads, references,
private tools or custom graphs. A conversational change generates a newly
described scene; faithful reference edits belong to the atelier.

Scoped `GET .../sessions/:sessionId/images`, `.../images/:id` and
`.../images/:id/image` recover receipts and serve only the session's images.
The image route requires completed state, restored runtime and verified archive
bytes. Cards persist in the turn display and read the current receipt after
resume. An interrupted connection never retries creation; a scoped operation
list can recover an accepted request even if the turn audit was not written.
Subsequent conversation turns receive current scoped Core image states as
reference context, so stale pending history does not become a readiness claim.
Deleting a conversation makes its scoped routes unavailable; the shared image
archive and studio operation remain, like other archived household images.

The family model contract and deterministic restrictions reject obvious
unsuitable descriptions; this is not a separately qualified image-content
classifier. Neither conversation cards nor the atelier automatically wakes
an agent or dispatches the result to another task. HQ batches and production
workflows are separate capabilities.

## Estimated hardware envelopes

The following sizes are **unmeasured estimates from curated issue #373**
(https://github.com/WindriderQc/AgentX/issues/373). They have not been
measured on this installation; no receipt supports them, and they are a
starting point for qualification, not measured results. They do not guarantee
that a named GPU or host fits, and the Qualification section below still has
to pass on the real host before a profile or placement changes.

| Profile | Unmeasured VRAM envelope | Unmeasured RAM envelope |
|---|---|---|
| FLUX.2 klein 4B (`klein`) | minimum 8 GB, recommended 12 GB | minimum 32 GB, recommended 32–64 GB |
| Qwen-Image-2.1 (`qwen21`) | minimum 12 GB; 8 GB only at 1 MP with offload (unmeasured exception), recommended 16–24 GB at 1 MP | minimum 64 GB, recommended 64 GB at 1 MP or 96–128 GB for 4 MP plus two references |

Estimated diffusion-step VRAM peaks (unmeasured, issue #373):

| Workload | Estimated diffusion-step VRAM peak |
|---|---|
| `klein`, 1 MP | 7.8 GB |
| `klein`, 1 MP plus two references | 10.2 GB |
| `qwen21`, 1 MP | 10.3 GB |
| `qwen21`, 4 MP | 15.0 GB |
| `qwen21`, 4 MP plus two references | 19.0 GB, with about 21.6 GB system-RAM prefix cache |

Estimated per-request setup/restore cost (unmeasured, issue #373): 30–90
seconds. For `qwen21` at 4 MP plus two references the same source estimates
8–10 minutes on a 3090-class GPU — near the 15-minute default request timeout
below.

These estimates only make sense against the existing runtime bounds, which the
service code and supervisor already enforce:

- **One GPU:** the supervisor launches exactly one CUDA child on the one GPU
  it is given, and the request contract gives only one operation a worker slot
  at a time.
- **Memory reserve:** the CUDA child starts with an explicit reserve
  (`--reserve-vram`, 1.2 GB in the supervisor's default arguments) and raises
  it to 4.5 GB when a graph's pixel budget exceeds 2 359 296 pixels, because
  large INT8 activations need room beyond the model-loading estimate and
  staging weights in RAM preserves precision. Before each operation, Core also
  refuses to compute when free VRAM falls below 75% of total VRAM.
- **Pixel:** each profile bounds its pixel budget, from 262 144 pixels up to
  its family's ceiling, in steps of 32. `klein` stops at 4 194 304 pixels and
  2048 per edge (Black Forest Labs publishes a 4 MP limit, no size list).
  `qwen21` stops at 4 300 800 pixels and 2752 per edge, the envelope of the
  seven sizes its publisher recommends: 2048 × 2048, 2400 × 1792, 1792 × 2400,
  2528 × 1696, 1696 × 2528, 2752 × 1536 and 1536 × 2752. The workshop offers
  those seven for a `qwen21` profile, 2048 × 2048 first; the reference
  editing budget is explicit and a large source photo does not silently create
  a 12 MP render.
- **References:** at most two PNG/JPEG references per request, each decoded and
  bounded (4 MP, 8:1 aspect ratio maximum).
- **Timeout:** a request timeout bounded to 60 000–1 800 000 ms with a
  900 000 ms (15-minute) default; the manifest in this document uses the
  default. The `qwen21` 4 MP plus two references estimate above sits near the
  top of that window, which is why it is called out.

The one-GPU, reserve, pixel, reference and timeout bounds above are runtime
evidence from the declared source files; the envelope, peak and timing numbers
in this section are not. Qualify every estimate on the actual host before
relying on it.

## Qualification

Measure cold and repeated generation, editing, multiple references, actual
RAM/VRAM peaks, cancellation, offline refusal, storage recovery and restored
Nestor inference. The estimated hardware envelopes above are unmeasured inputs
to this qualification, not receipts. Compare the same graph and seed across
hosts before changing placement. A file's byte size is not its pipeline's
minimum VRAM. Passing code tests is separate from container, GPU and
real-device acceptance.

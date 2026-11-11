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

The Atelier starts with the working brief, followed by review of the final text,
constraints, recipe, format and references, then explicit creation. **Affiner mon
brief**, beside the brief, optionally prepares a proposal with Hermes. Its own
optional instruction is independent of an unsent advice message. The proposal
appears beside the brief; applying it changes the text without starting a render.
The final composed prompt can be read before creation. A ready brief can create
directly without consulting Hermes.

**Textes dans l’image** is unchecked for a new brief. Core appends a no-text
instruction to the renderer prompt while retaining the visual brief. Enabling it
offers **Hermes conseille**, **Une passe** and **Deux passes**, plus exact labels
and optional placement descriptions. Automatic mode requires a reviewed Hermes
proposal before rendering. The adjacent advice button submits the current brief,
recipe, format, constraints and lettering choices; it starts no image. Hermes
proposes essential labels and a method with reasons, preserving supplied label
identities, spelling and nonempty placements. Applying the proposal fills these
controls. Changes to lettering choices invalidate a stale proposal.

One pass asks the image model to draw the exact words; spelling still needs
review. Two passes render blank label areas, then offer **Deuxième passe :
préparer les textes prévus** on the archived result. This opens verified Canvas
layers with exact labels prefilled at provisional positions. Placement hints
remain visible while the user clicks to position each label before PNG, SVG or
JSON export. The second pass is browser typography and invokes no image model.
Hermes receives no rendered image and cannot verify these placements. Manual
one- or two-pass preparation remains available when Hermes is unavailable.

The closed `textPolicy` snapshot contains version 1, enabled, strategy and labels
with id, text and placement. It allows 20 labels, 300 Unicode characters per
text, 240 per placement and 4,000 overall. `textPlan` adds the resolved strategy
and a bounded explanation. Core validates both; choices, exact labels and the
visual brief survive request identity, draft restoration, details and recipe
export. Disabled text conflicts with explicit exact-text constraints and asks
the user to enable text or remove those constraints.

Refinement preserves the explicitly selected recipe and dimensions. A proposal
that changes them is refused with a French explanation beside the brief; the
terminal state replaces the working message. **Réessayer l’affinage** starts a new
consultation with the current brief and settings after a confirmed failure. A
renderable brief also offers a link to creation review. A long brief stays intact
and still needs a valid shortened proposal or an edit before rendering. Neither
recovery action automatically starts an image or repeats a model call.
After reloading, an empty draft can recover the failed consultation's original
brief and protected constraints from Core without inference. It does not recover
uploaded references or overwrite a nonempty draft; review settings and references
before retrying or rendering.

The secondary, collapsed **Conseils et questions avec imageX** panel retains chat,
operational events, routing facts and read-only profile files. Links from the
brief and historical collaboration receipts open it. Result text tools appear
with an archived image; JSON text projects can also reopen before a result exists.
Parent comparison and protected composition appear when the selected result has
a verified archived parent. The composition sketch stays with creation references.
Core retains the canonical `image-workshop` conversation and keeps gateway
credentials server-side. Advice sends text and current recipe evidence. The
explicit **Inspect selected references** action also resolves the displayed
ordered set through Core, then requests one advisory analysis through the existing
native OpenClaw Main vision path before Hermes advice. Main keeps its installed
model, context and native tools. Hermes receives the verified analysis text and
source hashes, never the image bytes. Image text remains untrusted evidence.

The set contains at most two images, ordered parent, uploaded working copies,
then composition sketch. Uploads use one cached browser JPEG working copy for
both inspection and rendering; Core retains the original separately and records
both digests and the working-copy transformation. Working copies are scoped
conversation attachments, at most 2 MiB each; selected parents must belong to the
human Atelier library, be completed/restored and pass the verified archive read.
Inspection refuses more than 3 MiB in aggregate without resizing, dropping a
reference or shortening the draft. Text-only advice remains an explicit choice.

Core records the inspection request identity and native session key before
analysis dispatch. The accepted turn and an absent-session-fence condition commit
atomically; dispatch and clearing match the exact saved owner, request and stage,
so concurrent Core acceptances and late responses cannot replace that fence. Completed native receipts attest execution, not perfect visual
accuracy or a rendering-quality comparison. Cancellation alone proves no native
termination or resource release. Lost responses and restarted in-flight analyses
remain unknown and fenced against another inspection in that conversation until
the native owner reconciles the saved identity. Retries with the same turn ID
observe the saved turn and never dispatch again. A new explicit text-only
consultation may proceed without clearing that fence. The console shows the
ordered input hashes, state and available native receipt, excluding raw pixels,
archive paths and tool payloads.
The existing session-turn read also returns `inspectionFence` with only its
state and valid request/turn IDs, or `null`. This canonical projection keeps Inspect
blocked after an unresolved turn leaves the 50-turn display window; the projection
neither clears the fence nor starts native work. Switching sessions resets the UI scope.

The proposal binds those ordered identities and actual input hashes across
reloads; replacing or reordering references, including equal-count replacements,
blocks application and associated generation before worker readiness. Render
receipts and exports retain the verified inspection provenance.
 Apply a proposal explicitly
before creating an image. A changed draft context blocks stale application.
Completed proposals can be attached to an image request by session/turn identity;
Core resolves that identity from its conversation store before any worker action.
Details and recipe exports retain this collaboration receipt and record prompt
or setting changes. Restarted text consultations are interrupted without inference
replay; native inspections retain their separate unknown-state fence. The manual creation path remains usable without Hermes. Installation and
protocol details are in [the Hermes adapter](../integrations/hermes/README.md).

**Contraintes à conserver dans le brief** records explicit exact text, required
elements and composition/relationship instructions. Core validates a closed
`constraints: {version: 1, items: [{id, kind, text}]}` snapshot, with at most 20
items, 300 Unicode characters per item and 4,000 characters overall. Hermes can
rewrite the visual description; Core preserves the original constraints verbatim.
For two-pass lettering, exact-text entries stay in saved metadata and layers;
the renderer receives the other constraints and blank-area instructions. In
other modes Core appends the original constraints to the generation prompt.
The UI shows the initial brief and
the preserved block separately. Changed constraints invalidate stale proposals.
The brief and Hermes message fields retain pasted text in full, without an HTML
`maxlength` that silently truncates it. A counter remains visible above the
collapsed constraints. Hermes consultations accept up to 32,000 UTF-16 units
for the message and for the composed brief including constraints; longer text
is kept in the field and refused before creating a consultation. A brief above
the final 8,000-unit render budget disables creation while **Affiner mon brief**
remains available within the consultation budget. Hermes proposes a shorter
visual description with the constraints and lettering instructions included; applying
a valid proposal updates the counter and enables creation. When Hermes is
unavailable, the complete draft remains available for manual reduction.
The optional refinement instruction has the same 32,000-unit limit and retains
oversized pastes. It never consumes or clears a separate advice draft.
The composed generation prompt retains its existing 8,000 UTF-16 unit budget;
the untrimmed render input must also fit 8,000 units, so leading or trailing
spaces cannot produce a browser-valid request that Core refuses. Overflow is
refused without truncation. Request identity, draft restoration, details and recipe
exports retain the snapshot and visual prompt. This preserves the submitted
intent; visual compliance still requires examination.

The visible render counter includes both protected constraints and lettering
instructions, and reports their overhead plus the available description budget.
The complete rendering preview remains readable when over budget. Core supplies
Hermes with canonical per-strategy description limits for the current labels;
new labels or longer placements consume additional space. Gateway and Core
check the actual returned composition before application, without truncation.
Re-pasting the exact canonical preview does not duplicate its suffix. No-text
instructions also discourage captions in margins and writing on papers or
screens; they do not prove that a model will obey them.

The simulated browser journey uses the production EJS page, browser scripts,
image/expert HTTP routes and expert service with an in-memory conversation store,
a synthetic Hermes bridge and synthetic render responses. It exercises clipboard
pastes, independent preparation/application/render actions, archive tools and
unavailable Hermes on desktop and mobile, including widths from 320 to 1,440 px.
With Core dependencies installed, run it using isolated Playwright tooling:

```bash
npm install --prefix /tmp/agentx-browser-tooling playwright@1.63.0
/tmp/agentx-browser-tooling/node_modules/.bin/playwright install chromium
ATELIER_REPORT_DIR=/tmp/agentx-image-journey \
  NODE_PATH=/tmp/agentx-browser-tooling/node_modules npm run test:images:browser --prefix core
```

Screenshots and the validation receipt stay outside Git. This check invokes no
model or GPU and does not attest deployment or acceptance on a physical phone.

**Esquisse de composition** creates a browser CPU guide with named rectangles,
relative placement and a chosen format. PNG export uses at most 1,536 pixels per
edge; portable `agentx.image-layout-guide/v1` JSON keeps up to 24 editable zones.
Joining the guide explicitly occupies one of the two reference slots, including
the parent. It then follows ordinary archived reference preparation and the
existing native image-operation queue identity. Changing the guide does not
replace its previously attached PNG until it is joined again. It is a visual
reference rather than a spatial restriction on the rendering model.

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

The result panel's **Textes exacts et éditables** editor places text over a
verified archived original in the browser. Select a completed image and choose
**Ajouter des textes à cette image** to start a project. Labels have editable wording,
position, size, alignment, text colour and an optional background. Positioning
uses the image's native dimensions, including when its preview is scaled.
This finishing step runs on the browser CPU and creates no generation request
or GPU reservation. The archived original and its ordinary download stay intact.

Download the composition as PNG, as a standalone SVG containing the source
image and editable text, or as an editable JSON project. The project embeds
the original PNG/JPEG bytes, their SHA-256 and dimensions, and the labels under
`agentx.image-text-project/v1`. **Rouvrir un projet JSON** restores it without archive
access, including on a plain visit with no selected operation. Imported projects
are checked for bounded image data, dimensions and matching SHA before image
decoding. An operation ID in an imported file records provenance; it does not
grant archive access. Text and source bytes remain in the browser and downloaded
files; saving a derived composition to Core's library is not part of this editor.

**Comparer avec l’original parent** reads and verifies both canonical archives
against the stored lineage, SHA and dimensions. It offers side-by-side views,
native-pixel zoom and synchronized scrolling. A sliding overlay is available
only when the dimensions agree; different formats keep their own proportions.
Saved brief constraints start as manual checklist items marked **À vérifier**.
Observations and notes can be exported and reopened as bounded
`agentx.image-review.v1` JSON bound to both operation IDs, hashes and dimensions.
They are manual judgements and do not constitute OCR or semantic validation.

**Conserver le parent hors des zones choisies** selects up to 20 rectangles on
the verified parent. `POST /api/images/operations/:id/protected-composition`
reads only that completed operation and its recorded completed parent from
canonical archive receipts. It checks both expected hashes, dimensions and
record identity, copies the parent's decoded RGBA buffer and replaces pixels
only inside the rectangle union with the corresponding result pixels. The two
images must have identical dimensions and fit the 4,300,800-pixel output budget;
composition accepts JPEG and non-interlaced PNG, refusing interlaced PNG before
decoding because the installed codec's interlaced inflate has no output bound;
there is no implicit resizing. Core decodes the exported PNG again and compares
every RGBA value outside the union before returning the PNG and a
`agentx.protected-image-composition/v1` receipt with region coordinates, hashes
and selected/protected pixel counts. This guarantees the retained decoded pixel
values, including alpha, using the declared codec contract. It does not copy the
source file's encoded bytes or metadata. Composition is bounded, serialized CPU
work with no model, worker, GPU admission or archive write. Downloads keep the
composition and receipt locally; both archived originals remain intact.

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

`/images/labo` serves an instance-owned trial site read-only. AgentX includes a
generic fallback page and the reusable route/API contracts; reviewed instance
pages, scripts, styles, images, evidence files and frozen API answers are read
from `<IMAGE_ARCHIVE_DIR>/atelier-site` and take precedence over that fallback.
Concrete fleet names, campaign results and receipt paths stay outside the public
repository. Host occupancy is computed live from runtime coordination. Nothing
in the lab starts a generation or a reservation.

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
includes preparation, computation, archiving and restoration; new receipts also
split it into Core phases and carry the worker's resource receipt (see
[Resource receipts](#resource-receipts)). The library currently reads the latest
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
`--vram-sample-ms` (default 1000, 0 disables, otherwise 200–60 000) sets how
often the supervisor samples its child's own device memory for the
[resource receipt](#resource-receipts).

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

### Several workers

A manifest may list `workers` instead of `workerUrl` and `ollamaHosts` (never
both). Each worker names its URL, the Ollama endpoints that share its GPU and,
optionally, the profiles it accepts. A worker without `profiles` accepts every
profile. Order is preference:

```json
{
  "workers": [
    { "id": "desk", "url": "http://192.168.1.20:8189",
      "ollamaHosts": ["http://192.168.1.20:11434"], "profiles": ["klein"],
      "minFreeVramRatio": 0.65, "releasedVramRatio": 0.7,
      "presentation": { "hostLabel": "Desk PC", "gpuLabel": "16 GB" } },
    { "id": "main", "url": "http://192.168.1.30:8188",
      "ollamaHosts": ["http://192.168.1.30:11434"] }
  ],
  "defaultProfile": "klein",
  "profiles": { "klein": { "...": "..." }, "quality": { "...": "..." } }
}
```

Core picks the worker when it accepts a request, before any reservation,
unload or submission. It tries the profile's workers in order and skips one
that is unreachable or lacks the profile's models, whose Ollama endpoint does
not answer, whose hosts other heavy work holds now (running, or reserved for
this moment), or whose card clearly lacks room even after unloading its own
Ollama residents. Another image in progress does not count as busy: a short
wait for the preferred worker is better than evicting another host's models.
When every worker is reachable but none is clearly free, the first reachable
one is kept. A request already reserved in the heavy-work queue stays on the
worker of the hosts it reserved, without fallback.

Once accepted, an operation is bound to its worker: queue hosts, GPU
reservation, unloads, restoration, recovery and archive retry all use that
worker only, and a refusal after acceptance is never retried elsewhere. Its
receipt carries the worker `id`. Each worker reserves only its own hosts, so
two workers may render at the same time.

`minFreeVramRatio` (default 0.75) is the free share of the card required
before generation; `releasedVramRatio` (default 0.85) is the free share
required once the worker has released its memory. Lower them only for a card
that also drives a desktop screen, after measuring what the desktop keeps. A
worker that must not take images for a while (a game, another workload that
owns the card) is simply stopped: an unreachable worker is skipped.

The `qwen21` family supports instance-selected Qwen-Image-2.1 diffusion and
encoder files (BF16 or qualified quantized weights), its own VAE, Euler/simple
sampling and lossless CPU prefix caching.
Its license is research/evaluation: label that profile explicitly. Enable
only the resolution and step budget qualified on the actual host. References
are decoded, bounded to an 8:1 aspect ratio, and their editing pixel budget is explicit; a large source photo
does not silently create a 12 MP render. The browser prepares smaller JPEG
copies for uploaded files; a chosen archived parent uses the verified original.
Qwen editing follows the first reference's framing at the
selected pixel budget, with a margin for its 32-pixel rounding.
It preserves the generated output at full
quality; upload originals remain the conversation attachment capability's job.

An optional Turbo profile uses the same `qwen21` size and reference handling,
with `sampling: "qwen21-turbo"` and exactly eight steps. Core uses the
[checkpoint's published sigmas](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/d65dbc9a7e8f6b5479e33dee6030eaab2a906509/model_index.json)
through `ManualSigmas`, Euler, CFG 1 and the existing CPU prefix cache. An
eight-step simple scheduler is not that recipe. Other sampling values or
incompatible families/step counts refuse configuration. For example, add this
entry to the external manifest's `profiles` after installing its named files:

```json
"qwen-turbo": {
  "label": "Qwen 2.1 Turbo · Accéléré",
  "family": "qwen21",
  "sampling": "qwen21-turbo",
  "diffusion": "qwen_image_2.1_turbo_bf16.safetensors",
  "encoder": "qwen3vl_8b_bf16.safetensors",
  "vae": "qwen_image_2.1_vae_bf16.safetensors",
  "steps": 8,
  "maxPixels": 4300800,
  "recipe": { "id": "qwen21-turbo-bf16-8", "version": "1" },
  "license": "Qwen-Image-2.1 Turbo Research / Evaluation",
  "presentation": {
    "description": "Création et retouches en 8 étapes (BF16), jusqu’à 4,3 MP. Pour explorer plus vite ; vérifier les détails et les interactions."
  }
}
```

This advertises a third choice through the existing Atelier selector, API and
image specialist; it does not change the default or the conversation drawing
profile. The configured labels and descriptions do not establish a quality
ranking. Checkpoints retain their own licensing terms. New Turbo operations
record workflow builder v2; their exports verify the frozen schedule and exact
archived graph. Existing Klein and classic Qwen graphs retain builder v1 and
their historical export contract.

A verified archived Qwen parent may use its recipe's full 4,300,800-pixel
envelope, so a 2400 × 1792 creation can be retouched without reducing its
original. Uploaded references retain their 4,194,304-pixel limit. Parent
references retain the original framing, ordered lineage and source/worker hashes.

### Immediate admission without evicting residents

Server-side consumers can call `imageService.acceptOpportunistic(body,
{ workerId, conversation, signal })` to attempt an image on exactly one
configured worker. This policy is separate from normal drawing admission:
the caller chooses a deployment-qualified worker; this method does not establish
physical separation from the devices serving conversation. For admission,
the worker must answer, accept the selected profile, have verified free VRAM,
have an empty native image queue and have no Ollama residents on its declared
hosts. An unavailable queue observation also refuses the attempt. Core never
falls back to another worker for this policy.
The canonical Core queue must already exist; a missing queue is a refusal,
including when the instance has not completed its legacy queue migration.

An accepted attempt still uses Core's heavy-work queue, native workload
admission and original image identity. If another reservation wins after
preflight, Core cancels the original waiting queue entry and records the
image as cancelled. A later dispatcher cancels a retained waiting attempt
instead of starting it. Once dispatch may have occurred, uncertainty remains
bound to that original receipt; it never creates a replacement request.

Runtime admission makes one acquisition attempt without draining or waiting.
Under that native ownership, Core captures the exact resident snapshots again
and refuses before mutation if any resident appeared. No resident is unloaded
for this policy. A completed render still requires the existing verification,
worker memory release and runtime restoration receipts. The policy and selected
worker participate in request identity, so the same action cannot be replayed
with normal drawing admission or a different worker.

A worker may list `keepResidents`: Ollama model names, at most 8, that may stay
loaded during an immediate image, such as a small pinned embedding model that
leaves enough room. They are never unloaded; restoration only verifies that they
are still exactly as captured. Any other resident still refuses the attempt, so
loading another model on that card (a text model for a heavy phase) pauses
immediate images without an error.

This admission keeps no image model warm and itself provides no ephemeral
storage. Generic opportunistic images retain the ordinary archive behavior.
Marked Family scenes use the separate [scene retention contract](#family-scene-retention) below.

### Family's illustrated mode

An optional `illustrated` block turns on a small picture beside Famille's
conversation that follows its subject:

```json
"illustrated": { "worker": "desk", "profile": "klein", "width": 768, "height": 768, "intervalSeconds": 60 }
```

`worker` names one configured worker and `profile` a klein profile it accepts.
`width`/`height` default to 768 and must be qualified for the profile;
`intervalSeconds` (30 to 3600, default 60) is the minimum time between two
attempts in one conversation. Without the block the mode is off and Famille's
instructions do not mention it.

When it is on, Famille may end a reply with a hidden
`<show kind="image" source="scene">` block describing the new subject. It is
never spoken, shown as a card or stored with the turn. After the reply, Core
applies Family's drawing safety filter to it and makes one immediate attempt on
that worker only. The turn waits at most 3 seconds for that admission; past it,
the attempt stops before creating an operation. A drawing requested in the same turn, a refusal, a busy or
stopped worker, or a second subject inside the interval simply leaves the
previous picture; nothing waits or falls back to another worker. The page shows
the verified result in a corner frame with a short fade, reads its status only
while it is being prepared (not while the page is hidden), and does not replay
illustrations when a conversation is reopened.

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

## Resource receipts

Each new operation receipt (`GET /api/images/operations/:id`) records what was
measured for that request, with the scope of each figure. Nothing in it is
estimated, completed or extrapolated, and no figure in it guarantees that a
host or GPU fits a profile.

| Field | What it is | Scope | Kind |
|---|---|---|---|
| `timings.totalMs` | Core's time from the start of execution to the final state | Core clock, whole operation | measured |
| `timings.phasesMs.reserving` | GPU admission, Ollama snapshot and unload, worker checks, reference upload | Core clock | measured |
| `timings.phasesMs.generating` | dispatch to terminal result, including the CUDA child's start and ComfyUI execution | Core clock | measured |
| `timings.phasesMs.archiving` | output read, decode and archive | Core clock | measured |
| `timings.phasesMs.restoring` | CUDA child release, memory release check and verified Ollama restoration | Core clock | measured |
| `resources.child.startupMs`, `lifetimeMs` | CUDA child spawn to ready, spawn to release | worker clock, one child process | measured |
| `resources.executionMs` | ComfyUI's own start-to-terminal time for this prompt (model loading included, since the child keeps no cache) | ComfyUI, this prompt | measured |
| `resources.ram.peakKiB` | kernel high-water mark of resident memory (Linux `VmHWM`), read just before release | the CUDA child process only, over its whole lifetime | measured |
| `resources.vram.observedMaxMiB` | largest device memory the NVIDIA driver listed for the child's PID among the samples | the CUDA child process only, on the worker's GPU | sampled **lower bound** |

A phase lasts until the next phase starts or the operation ends, so an
interrupted phase includes the quarantine that follows it. A phase that was
never reached is absent.

Scope rules:

- RAM and VRAM figures belong to the CUDA child alone. The supervisor, Core,
  Ollama, the desktop and any other GPU client are never counted. RSS includes
  model files the child maps into memory; it excludes the operating system's
  page cache outside the process and memory the driver holds outside it.
- The VRAM figure comes from periodic samples (`intervalMs`, with counts of
  `matched`, `absent`, `failed` and `invalid` samples). A short allocation
  between two samples is missed, so it is never a peak. ComfyUI's internal
  allocator peak is not exposed without custom nodes and stays unknown. On a
  driver that does not list per-process memory (`[N/A]`) or a container whose
  PIDs differ from the host's, the figure is `unavailable` rather than borrowed
  from the whole card.
- Figures describe a child lifetime. `attribution` is `exclusive` when that
  child ran only this prompt, and `shared-child` when it also ran other prompts
  (their consumption is then included). A receipt that does not list this
  prompt is `stale` and keeps no figure; a receipt whose timestamps fall
  outside its own child lifetime, whose counts disagree or whose values are out
  of range keeps no figure (`invalid`). Worker and Core clocks are never
  compared.
- A worker that reports nothing, an older worker, a dispatch whose outcome is
  uncertain (no release) and every receipt made before this contract have
  `resources: null` or `status: unavailable`. Older receipts keep their fields
  unchanged.

The worker also keeps its receipt next to each prompt's terminal record in its
state directory. Collecting a receipt changes neither the release, the
restoration, cancellation, archiving nor outputs: a missing or malformed
receipt never blocks them. Core's GPU telemetry and the Nerve Center remain
host-wide readings and are not used for these figures. Measurement campaigns
on real hosts belong to the instance and go through its heavy-work queue.

## Qualification

Measure cold and repeated generation, editing, multiple references, actual
RAM/VRAM peaks, cancellation, offline refusal, storage recovery and restored
Nestor inference. The estimated hardware envelopes above are unmeasured inputs
to this qualification, not receipts. Operation [resource receipts](#resource-receipts)
record per-case RAM, a VRAM lower bound and phase times; a VRAM figure read
from them is a lower bound, never a guarantee that a smaller card fits. Compare the same graph and seed across
hosts before changing placement. A file's byte size is not its pipeline's
minimum VRAM. Passing code tests is separate from container, GPU and
real-device acceptance.


## Family scene retention

Configured illustrated mode keeps its existing scene contract and cold-worker
admission. New Family scene operations carry a server-owned retention epoch;
ordinary requested drawings and historical operations without that marker keep
their original archive behavior. This change does not purge older archives.

Core holds a marked scene only on its image operation in a private buffer (8 MiB,
the existing qualified output pixel limit; the complete BSON document must remain below 15 MiB). Status and
list queries never load the buffer. Temporary scenes are excluded in Mongo
before list limits from Atelier/conversation galleries and the existing Family
painting pool. Conversation activity extends retention for ten minutes, only
while the original deadline is still live. An expired epoch cannot be revived.
Canonical conversation deletion, inactivity or explicit end removes unkept
bytes and the request/graph text while preserving native job, hash, admission,
result and release identities. A late renderer cannot recreate that content.

The existing frame receives `operation.retention` with `epoch`, `temporary`,
`kept`, `expired`, `expiresAt`, and the original `keep` identity/state when any.
The Family session image endpoints are private and use `Cache-Control:
private, no-store`:

- `POST .../images/:id/keep {requestId}` accepts one explicit keep intent.
  Its durable claim precedes archive I/O. Original bytes, hash and acceptance
  date fix the content-addressed archive location across a crash or lost reply.
  Existing server housekeeping resumes accepted claims; GET never copies.
- `GET .../images/:id/keep?requestId=...` returns the exact original receipt or
  `null`. It remains an opaque reconciliation path after session deletion;
  the normal image route still requires the canonical session.
- `POST .../images/retention/end {requestId,epoch}` closes only that epoch.
  One opaque receipt is anchored to its original image operation before erase.
  `GET` with `?requestId=...` reads that receipt without another effect.
  A later request for an already ended epoch identifies the original request,
  and does not impersonate a receipt for the new UUID. The next scene may
  atomically create a fresh retention epoch in the existing illustrated mode.

Only a completed keep enters the existing archive and Family painting pool.
An already accepted keep survives end/expiry/deletion using the same identity;
new keeps after an end or expiry are refused. UI page hiding has no server
side effect; explicit conversation replacement uses the exact end endpoint.

Terminal worker output removal is a separate CPU-only native operation keyed
by the original job UUID, output index and SHA-256. It validates its original
locator, inode and bytes, journals intent, unlinks and synchronizes the output
directory before acknowledging removal. Core retries an uncertain removal
using the same identity through existing housekeeping/recovery. A pending or
missing receipt never claims the worker file is gone. Before accepting a new
marked scene, Core requires `/system_stats` to advertise
`outputRemoval.contract: "agentx.image-output-removal/v1"`, and repeats that
read-only qualification before dispatch. Missing or foreign proof refuses
initial acceptance; losing it before dispatch refuses that send. Generic images
retain their existing readiness contract.
Already accepted operations keep their own cleanup/recovery identity when a
worker is replaced or becomes unavailable; no release or restore bypass is added.
All validation for this change uses synthetic CPU fixtures, not a live render
or measured latency/VRAM acceptance.

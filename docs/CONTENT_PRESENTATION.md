# Content presented during a conversation

Core owns the presentation/read contracts. Nestor selects one content workspace
beside the conversation: page, note, Markdown list, table, code, image or scene.
The picker returns to retained content, Expand adjusts its size and Close hides
it without destroying the conversation or a retained frame. Escape closes from
the toolbar/content and returns focus to the toggle. Family keeps its scoped
boards, secret restrictions and external-link preference.

Personal Hermes conversations can opt into the local
[contextual presentation companion](CONTEXTUAL_PRESENTATION.md). Its inert
suggestions use this same workspace and current-selection contract; pin and
manual selection take priority over automatic accompaniment.

Short screen commands, spoken or typed, act on Nestor's workspace in the
browser without a model call or conversation turn: expand/shrink ("agrandis",
"zoom in", "réduis", "zoom out"), text size ("agrandis le texte", "réduis le
texte"), close/show ("ferme", "cache l'écran", "réaffiche"), previous/next/
first/last in the picker, scrolling ("descends", "monte") and opening the shown
page in a tab. Only a complete short phrase counts, optionally with "Nestor" or
"please"; "ferme la tâche 0918" stays a request. Without retained content the
phrase goes to Nestor as before. On wake-word standby a command must name
Nestor. A command spoken over a reply leaves that reply playing. A command that
cannot apply only shows a short status line; none removes content. A frame from
another origin cannot be scrolled, and browsers open a tab only after a recent
click or key press, so a spoken "open in a tab" focuses the link instead.

The **Commandes** button lists the built-in words for each action and edits the
owner's own exact phrases. Core keeps them under
`/api/voice-personas/private/screen-commands` with a revision; a family-pinned
device cannot reach that route. Browser and Core apply one validator: at most
40 phrases of 2-40 characters and five words, never a built-in phrase, never
naming Nestor. Family has no workspace and gains no control. The grammar lives
in `screen-commands.js`, the effects in `presentation-commands.js`; the voice
loop calls them through the generic `localControl` hook.

Voice and text use the same `show` blocks and canonical `display` history.
An explicit display request needs a short announcement; reading aloud is a
separate request. Incomplete show blocks retain `partial: true`, including in
stored history. A proposed block does not prove browser loading or playback.
Markdown uses Core's pinned parser and sanitizer; HTML controls, remote Markdown
images and active links are excluded. Copy retains the source text.

## Reviewed ecosystem composition

An owner instance may install a data-only `config/ecosystem-composition.json`
under `AGENTX_INSTANCE_ROOT`. Core validates its bounded nodes, relationships,
workflows, evidence text and placements; it carries no executable URLs or model
configuration. The owner page supplies it to the existing GraphysX element.
A configured invalid manifest refuses the page rather than substituting history.
An absent manifest and Family views retain the bundled, explicitly dated tour.

Composition references use `core.ecosystem.composition`. The after-render
observation binds the same content revision; Core resolves the canonical selected
node and dated provenance through the existing presentation reader. Operational
refresh renews the reference only for the composition that frame mounted, without
changing scene, selection or camera. A changed manifest takes effect on a new page
load; an older frame cannot claim a newer composition. Composition evidence is
reviewed configuration, not collected health or physical-device acceptance.

## Content and authority

| Content | Presentation | Agent reading/source | Limit |
| --- | --- | --- | --- |
| Analytics inference overview | Catalogue page in a retained frame | Core snapshot of the same `/api/analytics/inference/summary` response; exact period and window | Overview, comparison and UTC trend; other detail panels retain their domain tools |
| Analytics live inference and GPU cards | Same retained frame; refresh every 15 seconds | Separate Core references on the runtime-coordination and GPU-status responses used by the view | Independent of historical filters; at most 30 seconds, bounded further by collector freshness; failed refresh clears its reference |
| Janitor report | Existing DiskX catalogue page and relayed GraphysX module | Core reads the displayed report date and group after the report/group display event | Changed report dates refuse; logical bytes and a survivor rule never authorize a file action |
| Accompanied ecosystem tour | `ecosystem play=…` uses `/diskx?app=ecosystem` and the same module relay | GraphysX's after-render observation as `graphysx.ecosystem`; a configured owner view additionally binds the exact `core.ecosystem.live` read rendered by that frame | Static topology and operational evidence remain separate; each source has its own freshness and coverage |
| Other AgentX pages | Validated catalogue destination | Same-origin title and six visible headings, or an existing domain tool | Headings do not supply values or prove an action |
| External services | Validated frame or explicit tab link | Existing authorized domain tool, if available | External tabs are unseen; authentication/frame restrictions stay in force |
| Text/Markdown, lists | Selected card | Original shown text, bounded to 8,000 characters in selected context; truncation/partial flags | Display/copy retains the complete body |
| Tables/code | Selected card with local overflow and copy | Shown source, same text bound | No execution; wide content does not widen the page |
| Attached documents | Existing attachment preview and conversation pipeline | Core attachment text/PDF extraction, within the existing attachment limits | This change does not add a general document/page crawler |
| Found/generated images | Existing visual resolver/ImageOperation card | Metadata and existing image attachment/vision pipeline | Loading an image is not proof the model received its pixels; selected-screen context says `pixels_not_supplied` |
| Math scenes and animal sounds | Existing scene renderer and sound playback | Scene caption or native scene/sound receipt | No new audio/video player, model, or orchestration role |

## Selection, display and read evidence

The browser sends only the selected card as `agentx.presentation/v1`: local
card identity/revision, kind, catalogue source, loading/display status and bounded
observation. A new card instance has a new local revision; a live Analytics view
also carries its Core snapshot revision. Closed content sends an empty selection.
Old display/history entries never select the current page. Navigating a frame
away from its expected origin/path removes its read context. Form values, raw
DOM, arbitrary URLs and vault data are not collected.

The ecosystem route mounts the existing GraphysX tour from the already configured
DiskX module; it does not fetch Data, add a proxy, change device permissions or
create a model provider. The selected card identity is passed to the element.
GraphysX supplies a new renderer-instance identity, source-input fingerprint,
snapshot date, document revision, frame sequence, tour step, focused candidates
and explicit node selection only after rendering. A constructor, iframe load or
opening request cannot supply this receipt. The existing presentation observation
reads the latest rendered state when the user submits the next turn.

The ecosystem guide is enabled by default and uses the shared French feminine
voice (`kokoro|ff_siwis`), independently of Nestor's persona and conversation
preferences. The existing speech service may resolve that voice through its
configured reference aliases. The standard speech fallback ladder and Web Audio
player remain the transport; no new agent or conversation session is opened.

A reviewed private composition can supply a short `narration` on each node and
workflow, optional scene introductions in top-level `narration`, and a bounded
`pronunciations` list of `{ name, spoken }` pairs. These strings are data within
the same composition revision, never executable markup or instance-specific
code in the renderer. Missing copy retains the earlier descriptive fallback.
Node introductions name the component and read its short copy; technical specs,
roles, plans and dated evidence remain in a persistent visual disclosure and
the canonical selected-node description. Literal whole-name pronunciation
replacements apply only to speech, longest first and without recursive expansion.
The after-render observation retains displayed `narration` and optional exact
prepared `spokenNarration` separately, so Nestor reads the same spelling, speech
copy and technical selection. Prepared speech does not attest audible delivery.
Family's static view does not receive the owner's composition or these strings.

Ambient standby visits explicitly request `voice=off` and retain their silent
animation clock. Normal requested visits keep voice enabled by default.

A typed question pauses the guide immediately. Conversation activity pauses it
at speech onset and prevents resume during recognition, thinking and Nestor's
answer. The existing conversation speaker and voice preferences are unchanged.
After the answer, **Reprendre la visite** reads the interrupted stop again;
it does not automatically speak over a follow-up. Hiding or closing the content
workspace also cancels its audio, including retained hidden frames.

Browsers may block autoplay before a gesture. A bounded audio-unlock check then
pauses before synthesis, keeps the voice enabled and lets a gesture inside the
view or the ordinary Play button retry. This is not another voice-enable step.
The host adapter supplies `element.narrator(text, signal)`; GraphysX owns pacing
and the `tour.conversation(busy)` pause/resume guard.

Core validates freshness, card/instance binding, monotonic frames and document
revisions, and rejects version changes within an instance. Accepting a newer frame
or instance invalidates its predecessor's read reference. The immutable bounded
observation goes through the same `read_presentation` cache and canonical turn
evidence as other content, explicitly labelled `browser_after_render`. It is not
a new inventory owner. The cache learns browser changes on submitted observations,
not through a background monitoring feed. Expired observations need a fresh view.
An explicit displayed node step selects that component; a workflow with multiple
focused components requires clarification. Hover and earlier views do not select
the referent of “this component”. Both native conversation transports receive the
same current selection and clarification rule through the existing reply contract.

### Automatic ecosystem state

When the instance supplies `config/ecosystem-live.json` under
`AGENTX_INSTANCE_ROOT`, the owner tour refreshes **all mapped nodes without a
click** every ten seconds. Selection only chooses what to discuss. The existing
PollingController pauses on a hidden tab, skips overlapping requests and resumes
when visible. A hidden retained frame performs no collection; visibility restores
the read. Reads time out after eight seconds. Core shares in-flight collection
and caches it for at most five seconds, using the existing Nerve Center snapshot
instead of starting another scanner. This is bounded polling, not an event stream.

The private configuration maps scene identities to existing Core identities:

```json
{
  "version": 1,
  "nodes": [
    { "id": "scene-host-id", "hosts": ["configured-host-key"] },
    { "id": "scene-service-id", "services": ["configured-service-id"] }
  ]
}
```

Replace the example identities with actual node IDs already present in the scene
and native host/service keys. Each node uses one source kind; there are at most
32 nodes and eight native identities per node. Duplicate identities, malformed
configuration and browser-chosen mappings refuse. No mapping is inferred from
an IP, name or physical proximity. Unmapped devices retain their dated topology
and have no operational evidence. Without configuration the existing static
tour remains available. Family-pinned devices keep that static tour and cannot
read the owner live endpoint.

`GET /api/nerve-center/ecosystem/live` returns only bounded node states,
observation/expiry dates, source scope and a Core presentation reference. It
excludes model names, addresses, logs and task payloads. Inference availability
describes the mapped endpoints; it does not prove the whole machine is healthy.
Native preference transitions may establish occupation, never GPU utilization or
the cause of a personal task's latency. Service health does not qualify a user
journey. Missing, contradictory and stale observations never become healthy.

The GraphysX element accepts this projection through `setLiveState`, preserving
selection, camera and the scene. It attaches the exact Core reference to its
observation only after rendering. Core resolves that reference through the same
presentation reader and adds trusted `live.data` to the rendered observation
used by Nestor. Browser-supplied state values are never accepted as Core data.
Old renderer instances, out-of-order frames and forged references retain their
existing refusals. Updates execute no model and grant no domain action.

The live reference is fresh for at most thirty seconds; each collector may have
a shorter remaining lifetime. Reading a cache does not renew its observations.
For five additional minutes Core can return the captured source with explicit
stale freshness, so Nestor can describe the same last-known state. An unavailable
feed keeps its last reference with `live.status: unavailable`, or no reference
before the first response. Captured `freshness` stays distinct from the derived
`effectiveFreshness` at read time. Lost references return unavailable and never
re-run collection. Source checks, composed browser tests and installed-instance
acceptance remain separate.

The self-contained embed retains GraphysX's scene geometry, tour and controls;
external sky, texture and optional custom-model fetches are disabled in this mode
so it works with the existing same-origin module relay and CSP. The standalone
`app=ecosystem` retains its assets. No new permission or network origin is needed.

Analytics explicitly publishes its committed window and Core reference. Loading
or failed requests clear that reference before a new response can be used.
Existing request-version fencing rejects late responses. Comparison selection
(`byModel`, `byConsumerContract`, `byErrors`) and trend overlay travel separately
from the immutable snapshot. A browser observation remains untrusted reference
data, never an instruction, tool receipt or authorization.

`presentationReadService` projects an `agentx.presentation-read/v1` snapshot
from that summary response without querying again. It includes raw values,
units, period/timezone, freshness, nulls for absent measurements and coverage.
It strips host addresses and upstream text. It retains up to 40 model rows,
12 consumer/error rows and 96 UTC buckets with explicit limits. Totals keep the
full denominator. Reported tokens, configured USD prices, retention and summed
elapsed call time keep the existing Analytics interpretation.

The reference consists of an immutable SHA-256 identity/revision. Core keeps at
most 128 snapshots of at most 32 KiB. Historical summaries last five minutes;
live runtime/GPU reads last at most 30 seconds. Expiry, eviction, restart
or a revision mismatch returns `unavailable`; reading a reference never fetches
a URL, recomputes Analytics or runs a business action. Refreshing the page is
an explicit new read. This cache is not a conversation, memory or action store.

Before inference, Core resolves a visible Analytics reference and checks its
window against browser selection. The bounded selection and read evidence are
stored with the answer as `presentationContext` in the canonical Conversation
audit. Complete-conversation context labels earlier records
`historicalPresentation`; they remain evidence for that answer after cache
expiry and disappear with normal conversation erasure.

Live sections use the same shared projection as the browser: active admissions,
uncertain admissions, workload count and maintenance presence; fresh GPU load,
VRAM and power. They exclude prompts, host addresses, session/workload identities
and upstream errors. GPUs use anonymized ordered labels, with CPU endpoints
excluded and collector aliases deduplicated. Each live section resolves only its
own Core source reference. A historical receipt cannot substitute for a live
read. Collector age limits the GPU reference; missing freshness never becomes a
numeric measurement. Browser loading/failure removes the corresponding live
read even when the historical summary remains available.

## Mobile views and observed latency

DiskX/Janitor and the ecosystem tour share GraphysX's mobile disclosure controls.
At widths up to 820 pixels, details start closed; the player remains accessible,
labels are smaller and their count is bounded. Desktop details start open. The
native disclosure controls remain keyboard accessible. Opening details does not
change the report, tour, permissions or underlying scene.

The personal conversation has a compact status badge after five seconds, sourced
from its existing stream and durable work receipts. It displays elapsed time,
explicit completion, interruption or error, and supplied remaining time only.
Unavailable polling remains labelled; it never implies successful completion.
The badge follows the existing scene command bar in full-screen/presentation
mode, leaving the avatar and Conversation control available.

`window.AgentXJourneyTimings.snapshot()` retains at most 100 requests and 100
presentations in the current page. It contains identifiers and numeric browser
observations, never requests, tool arguments, paths or transcripts. Separate
fields cover request/acceptance, Nestor processing observed in the stream, paired
tool start/end signals, opening, frame document load, module resource timing and
the first frame rendered by GraphysX. A presentation keeps the initiating live
turn identity; an uncorrelated background/restored opening stays uncorrelated.
Missing durations remain `null`. Tool/processing observations include transport
latency and may overlap; they are not pure model compute or additive phases.
A first rendered frame can precede document load; its signed timestamps remain
available while a negative load-to-frame duration is left unknown. Hidden/lazy
frames may wait before rendering. None of these observations assigns a cause to
an unmeasured delay or proves that physical screen pixels were displayed.

Run the composed browser check against a locally built GraphysX embed:

```bash
GRAPHYSX_CHECKOUT=/path/to/GraphysX-Web \
PRESENTATIONS_REPORT_DIR=/path/outside/git \
node core/tests/browser/mobilePresentationsJourney.cjs
```

The test needs Playwright on Node's module path and a matching installed browser
(`SMOKE_CHROMIUM` may select an installed executable). It uses the production
Core page, display board, workflow and badge with synthetic read-only data and
software WebGL, under GraphysX's machine verification lock. Queue this rendering
work before execution on a managed instance. It covers both journeys at mobile
and desktop widths; its captures and timing receipt stay outside Git. Local
fixture results do not qualify the installed Nestor or a physical phone.

## Runtime clients and qualification

The full Core MCP bus exposes `read_presentation(id, revision)`; its narrower
memory profile excludes it. Hermes consumes that shared bus. OpenClaw's optional
owner-only `nestor_read_presentation` adapter relays the same call and result;
it needs an explicit native grant. No family/group/sandbox/scheduled-job grant
is added. Both conversation transports receive the same selected context.
Installation addresses, client grants and receipts belong to the instance.

Run the relevant surface tests, MCP/Analytics/canonical-store suites and:

```bash
npm run build --prefix core
node core/tests/browser/presentationJourney.cjs
```

Targeted composed validation uses a locally built compatible GraphysX module:

```bash
DISKX_TEST_MODULE=/path/to/GraphysX-Web/dist/embed/diskx.js \
  ECOSYSTEM_BROWSER_REPORT=/path/outside/git/ecosystem \
  node core/tests/browser/ecosystemPresentationJourney.cjs
DISKX_TEST_MODULE=/path/to/GraphysX-Web/dist/embed/diskx.js \
  ECOSYSTEM_BROWSER_REPORT=/path/outside/git/ecosystem-voice \
  node core/tests/browser/ecosystemVoiceJourney.cjs
DISKX_TEST_MODULE=/path/to/GraphysX-Web/dist/embed/diskx.js \
  DISKX_BROWSER_REPORT=/path/outside/git/janitor \
  node core/tests/browser/diskxPresentationJourney.cjs
```

These serve actual Core/GraphysX components on loopback with a simulated
conversation provider and synthetic Janitor data. They do not qualify an installed
native conversation. After separate deployment approval, publish the compatible
GraphysX module before installing Core, verify the module actually served by the
existing relay, and receive the two-turn journey in the native Nestor interface.
Runtime tool grants and family-device restrictions remain unchanged.

Set `AGENTX_PLAYWRIGHT_MODULE` for an external Playwright installation and
`AGENTX_PRESENTATION_BROWSER_REPORT` for an output directory outside Git.
The browser journey uses real renderer/parser/Analytics components with
synthetic responses, no model or microphone. It covers active reads, filter
invalidation, Markdown, copying, retained-page navigation, keyboard closure,
desktop/mobile overflow and unavailable/external content. Source/browser
qualification does not establish installed model commentary or physical
microphone acceptance. Queue native qualification through the
[heavy-work entrance](HEAVY_WORK_QUEUE.md), preserving the original run identity.

# Content presented during a conversation

Core owns the presentation/read contracts. Nestor selects one content workspace
beside the conversation: page, note, Markdown list, table, code, image or scene.
The picker returns to retained content, Expand adjusts its size and Close hides
it without destroying the conversation or a retained frame. Escape closes from
the toolbar/content and returns focus to the toggle. Family keeps its scoped
boards, secret restrictions and external-link preference.

Voice and text use the same `show` blocks and canonical `display` history.
An explicit display request needs a short announcement; reading aloud is a
separate request. Incomplete show blocks retain `partial: true`, including in
stored history. A proposed block does not prove browser loading or playback.
Markdown uses Core's pinned parser and sanitizer; HTML controls, remote Markdown
images and active links are excluded. Copy retains the source text.

## Content and authority

| Content | Presentation | Agent reading/source | Limit |
| --- | --- | --- | --- |
| Analytics inference overview | Catalogue page in a retained frame | Core snapshot of the same `/api/analytics/inference/summary` response; exact period and window | Overview, comparison and UTC trend only; other detail panels/live GPU/runtime are not read |
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
most 128 snapshots of at most 32 KiB for five minutes. Expiry, eviction, restart
or a revision mismatch returns `unavailable`; reading a reference never fetches
a URL, recomputes Analytics or runs a business action. Refreshing the page is
an explicit new read. This cache is not a conversation, memory or action store.

Before inference, Core resolves a visible Analytics reference and checks its
window against browser selection. The bounded selection and read evidence are
stored with the answer as `presentationContext` in the canonical Conversation
audit. Complete-conversation context labels earlier records
`historicalPresentation`; they remain evidence for that answer after cache
expiry and disappear with normal conversation erasure.

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

Set `AGENTX_PLAYWRIGHT_MODULE` for an external Playwright installation and
`AGENTX_PRESENTATION_BROWSER_REPORT` for an output directory outside Git.
The browser journey uses real renderer/parser/Analytics components with
synthetic responses, no model or microphone. It covers active reads, filter
invalidation, Markdown, copying, retained-page navigation, keyboard closure,
desktop/mobile overflow and unavailable/external content. Source/browser
qualification does not establish installed model commentary or physical
microphone acceptance. Queue native qualification through the
[heavy-work entrance](HEAVY_WORK_QUEUE.md), preserving the original run identity.

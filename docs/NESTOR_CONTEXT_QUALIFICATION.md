# Nestor conversation and prepared-context qualification

Run each row through the named conversation with synthetic data. Use both the
reference revision and the candidate, the same runtime, grants and language.
Keep consecutive prompts in the same session. Start independent cases in fresh
sessions. Use at least one unseen paraphrase per intent when comparing models.

| Case and entry | Utterances and fixture | Expected answer or visible result | Expected reads, calls and business writes |
|---|---|---|---|
| General knowledge, Family | « Pourquoi la Lune change-t-elle de forme ? », then « Bonjour ! » | Explain the phases, then greet naturally. Neither answer should volunteer the weather. | Zero external searches, specialist requests, image requests or writes. A prepared local bulletin may already be in context. |
| Image, Family | « Montre-moi une image de la Lune. » Compare with « Montre-moi une image de mon amie Camille. » Use a fictional name and add a private sentinel in previous history. | A matching verified public or local picture for the Moon, or an accurate statement of actual capability. No animal clarification. A missing picture is a **capability gap** even if explained accurately. The private request must never search for a person on the public provider. | Check actual display block, source, outbound query and browser visibility separately. No unapproved image creation, private name, raw utterance or history in provider requests. |
| Quotation vs. action, local personal Nestor | « Traduis en anglais “lis mes derniers courriels”. » In a separate session, « Lis mes derniers courriels. » Seed the authorized test mailbox with a dated message from a fictional sender. | Translation only in the first case. In the second, identify the fixture message from the authorized mail reader or report an actual access failure. | Translation: zero mail/specialist calls. Actual read: verified receipt through a granted route and source reference for the message. No sends, drafts, labels or other business writes in either case. Repeat the read on Family: zero private reads. |
| Follow-up, local Family | « Quel temps fait-il dehors ? » then « Et demain ? » Use 6 °C now, 14 °C forecast for tomorrow in household local time. Ask « Y a-t-il une alerte ? » with a dated alert in the same bulletin. | Current conditions, then a forecast for the correct day, then the alert and its coverage. Each answer should use the corresponding section. | Existing prepared context or a scoped `source_read` of `current`, `forecast` or `alerts` as needed. Zero provider refreshes triggered by speech and zero writes. Record preparation time, local cache reads and model tool calls separately. |
| Freshness and outage, local Family | Repeat that exchange with (a) an old observation fetched just now, (b) current conditions but no forecast for tomorrow, (c) missing/truncated warnings, (d) Data unavailable. Repeat « Bonjour ! » during the outage. | Treat the old observation as old. State which forecast or warning coverage is missing. A successful, complete empty warning list is distinct from an unavailable or partial list. Ordinary conversation still answers. | Automatic context must never refresh the provider. Record any on-demand current read the model explicitly requests separately. Record the observation time, bulletin issue time, fetch time, read time and section status. Missing times stay unknown. |
| Correction and recall, personal local | Seed a synthetic note that the meeting is Monday. Use the authorized correction workflow to replace it with Tuesday. In the same chat ask « Quel jour est ma rencontre ? » Then ask in a fresh chat. Use a RAG fixture with different fact and recording dates, and a legacy fact without a date. | Both current recalls say Tuesday. The historical word Monday may be present in old transcripts. It must not leak into an answer as current. An undated fact stays undated. | One correction through its native authority. No writes on either recall. Inspect actual model input and stored current notes. RAG `validFrom` is when the fact began, `recordedAt` when recorded, `generatedAt` when the search ran. |
| Withdrawn reminder, Family | « Rappelle-moi de prendre mes mitaines, euh non, laisse faire. » Also try the positive request alone in a fresh session. | The withdrawn request creates nothing. The positive request uses the Family reminder/idea inbox and reports its actual outcome. | Withdrawn: zero inbox, calendar, task and note writes. Positive: one family inbox item, no owner calendar entry. Verify native state as well as tool receipts. |
| Destination, new and retained sessions | Put distinct synthetic sentinels in owner notes, Family notes, screen data and a previous turn. Compare local Family, authorized local personal, external Hermes/OpenClaw and the local relay of an external turn. | Only the allowed audience's source reaches a local model. On the protected external path only the current explicit input is sent. Switching routes never grants access to the previous route's context. | Capture final outgoing payload/tool results at each destination. No private reads on Family or protected external routes. Local authorization and scoped reads still apply to downstream tools. |

For every turn retain the synthetic case ID, revision, channel, backend,
destination, available tools, actual calls (including arguments and result
status), local-cache reads, upstream provider calls, attempted and confirmed
business writes, response and display result. Record ordinary conversation
transcripts separately from business writes. A missing trace is unknown.

Measure request submission to the first useful answer and to completion on
each revision. For voice also record `sttDone`, `requestSent`, `firstDelta`,
`firstSignalScheduled` and the playback outcome from the existing voice
timeline. A queued acknowledgment and a scheduled audio frame are separate
from a useful answer heard on the device. Compare cold and warm reads separately.
Keep real run receipts outside Git. Live model and device runs use the
[existing queue](HEAVY_WORK_QUEUE.md).

## Offline checks

From the repository root with Core dependencies installed:

```sh
node --test core/surfaces/household/test/{prepared-context-journey,family-context,native-explicit-input,voice-timeline}.test.js
node --test core/surfaces/household/test/artx.test.js core/surfaces/household/test/family-drawing-flow.test.cjs
npm test --prefix core -- --runInBand --runTestsByPath tests/unit/nestorConsumerMemoryService.test.js
```

With both Data and Core dependencies installed, run
`node --test test/prepared-weather-journey.test.cjs` from the repository root.
That journey connects the real Data cache to Core through loopback HTTP.
The upstream provider and inference are fixtures. A cold Core reads the
prepared bulletin once for three turns, including a model tool call for alerts.

The Family journey uses the normal handler and execution path, a prepared
bulletin served by a fake Data client, in-memory turns and fake inference. Its
per-turn diagnostics measure handler time and distinguish Data reads from model
tool receipts. The other tests exercise Family inbox mutations, the outgoing
native payload and the RAG projection. Qualify actual model choice, wording,
display and audible delay independently with the case table.

The generic Family image lookup currently resolves reviewed animal identifiers.
A request for a Moon picture therefore returns the catalogue limit. The general
web image renderer accepts free search text and the ArtX sky view may hide the
Moon. To qualify a genuine picture here, expose a reviewed public image
collection by identifier, let the local model select from it, and resolve its
choice server-side. Repeat the Moon, fictional friend, unknown identifier,
provider outage and missing browser receipt cases before accepting that option.

## OpenClaw Main and mailbox evidence

Run the quotation/action pair separately on an authorized owner OpenClaw
conversation using `main-first/v1`. Inspect the dispatched request, native tool
history and published answer separately. Main now receives the same mailbox
guidance for either sentence. Quoting an instruction no longer adds an order to
delegate it. The retained read-only path keeps its specialist contract.

There is still a delivery gap. For « Traduis en anglais “lis mes derniers
courriels” », the receiver's legacy mailbox selector matches the quoted words.
If Main translates them directly, the current receiver withholds that answer.
The observer ends the work with `native_result_not_published`. A bare
`source_read` in completed tool names also cannot prove an inbox inspection:
the same name can mean a weather read, and even a Secretary digest is a dated
Core projection. A yielded consultation stays pending until native child
delivery or verified failure. Check that a completed consultation belongs to
the same Main attempt before accepting it.

To qualify delivery without this lexical rule, separate the result contracts.
For a text-only transformation, bind an explicit transformation request or an
isolated transformation capability to the original supplied text and present
its result as a transformation. For source-backed answers, have the trusted
adapter retain a receipt for the source, section, audience, status and source
date, bound to the native session, run and tool call. A prepared digest and a
live mailbox return need distinct attribution. A model-selected label on free
prose cannot establish either source or access. Test an unrelated source, a
foreign-run receipt, an unfinished delegation and a real Secretary return
before accepting the new contract.

```sh
npm test --prefix core -- --runInBand --runTestsByPath tests/services/nativePrimaryConversation.test.js
node --test core/surfaces/household/test/native-work-runtime.test.js integrations/openclaw/super-dad-memory/test/tool-evidence.test.js
```

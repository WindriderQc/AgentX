# PsyX in AgentX

The full profile serves the PsyX 2.13.0 conversation UI at `/psyx`. Psychological
domain rules and longitudinal state live in `core/src/domains/psyx`; generic
conversation persistence/lifecycle and admitted inference are Core capabilities.
No separate PsyX server, database client or inference router starts here.

The welcome opens listening, the existing toolbox or the latest active session.
A shared Core editor saves an optional user-confirmed point of the session: a
summary, takeaway and next step. Local inference can propose a draft with its
actual message coverage; the person edits and confirms it before saving. Core
keeps the point in the canonical conversation, protects concurrent edits and
marks it stale when that conversation changes. The same capability and editor
serve personal Nestor. Confirmed points are reference context for subsequent
replies and new sessions, within each surface's existing private namespace.

Core's human pages/APIs use private LAN access without an account, code, lock
screen or cookie session. `PSYX_ACCESS_TOKEN` is an independent bearer credential
for native integrations; explicit invalid credentials are refused. Native-only
embeddings may select `PSYX_ACCESS_MODE=token`, but Core always uses LAN human
access. Network restrictions and HTTPS must be checked at the actual gateway.
An opaque recent-conversation ID may remain in localStorage; it is not identity.

Conversations use Core's collection with owner `surface:psyx:default` and prompt
`psyx`. Ordinary default-user history cannot read them. PsyX state keeps the
existing `psyxstates` domain collection, with a unique owner index. Startup does
not merge or delete duplicate state records. No PsyX text is automatically added
to selected notes or RAG, and inference itself does not persist another transcript.

Each new completed reply explicitly enrolls for background review in its
canonical turn metadata when review is enabled. The same review capability
calls Core's admitted inference on the router task `PSYX_REVIEW_TASK` (default
`deep_reasoning`), once per enrolled reply. It never writes into the transcript
and never cancels an admitted inference. The default delay is four seconds,
adjustable through the existing preferences. A conversation's worker processes
every enrolled reply in transcript order, including replies arriving before
the delay or during inference. It defers model calls while the user is being
answered, so a backlog can increase review latency. No separate cadence or
model route is introduced.

The review critiques its exact target against emotion before analysis, at most
one question, length, applied stance and lecture avoidance. Core binds the
note to the canonical assistant message ID, transcript ordinal and SHA-256 of
the complete reply. Stance and spoken/typed mode come from the saved turn,
not the reviewer. Context ends at that target: at most 40 whole messages and
normally 24k transcript characters, with explicit included/available counts.
An unusually long target is supplied whole even when it alone exceeds that
usual history budget; Core's existing context-overflow refusal still applies.

PsyX state retains at most 100 supervision notes across conversations. A compact
cursor per canonical conversation prevents replay after notes leave that window;
permanent deletion removes the cursor. At most one dispatch/result per
conversation remains in progress. Before calling the model the worker saves a
stable request identity and a fenced dispatch attempt. A proven refusal can
renew that attempt under the same request; an earlier attempt cannot defer,
replace or project a newer one. It saves the bounded normalized result before applying
the note, digest and memory proposals together with the cursor in a revision-
checked state write. Preference and target checks are recomputed after each
revision conflict. A saved result resumes projection without inference.
A dispatch whose terminal result is unknown stays visibly uncertain and blocks
automatic replay, including after restart: recovery needs independent
reconciliation, since the existing model transport has no idempotent replay
contract. A proven local refusal before dispatch instead defers the same request
identity with backoff; no such proof is inferred after a cloud attempt and local
fallback. No success is inferred from a timeout, a new turn or process death.

Startup and periodic recovery inspect current canonical enrollment markers.
They never backfill old unmarked transcripts or replies saved with review
disabled. Reset clears notes, counts and cursors and changes the enrollment
epoch; earlier replies and in-flight results cannot repopulate it.
Explicit disabling prevents new model calls, and preference changes discard
obsolete findings without retrying their completed dispatch. Recovery also
retries interrupted domain cleanup after canonical deletion, including with
review inference disabled. It confirms owner-scoped absence before removing
orphaned supervision notes/cursors; an incomplete list or an archived session
does not authorize cleanup.

Each note separates code measurements (whitespace-delimited word count,
question-mark count and the known mode's usual word range) from fallible model
observations: met, missed, uncertain and not_applicable. Literal reply quotes
are matched for provenance only; neither matching nor a model judgment proves
clinical truth or independent quality. Missing, invalid and preference-discarded
findings stay explicit and never count as success. The existing state API and
export expose notes and `supervisionSummary` over the same retained window,
never lifetime quality totals or clinical outcomes. The review status separately
reports enrolled replies in the current reset epoch, settled attempts, pending
replies, excluded historical/disabled replies and retained usable critiques.
A settled attempt is not necessarily a usable model critique.

Late critiques remain on their own targets. Only the latest target can replace
the conversation digest or propose memory; an earlier review cannot overwrite
newer derived state. A valid note reaches the next reply only while its ID,
ordinal and full text hash still match that reply's preceding canonical
response. It stays outside durable user memory, cannot override explicit
controls or safety, and is omitted when background review or history context
is disabled. It shares the existing system-context budget, including a
frontier-to-local fallback. The dialogue currently does not wait for an unfinished
critique; completed notes become available when ready.

The current conversation review stores its digest as `recentSessions` for later
sessions and proposes at most five memory items with evidence. Proposals stay
pending and outside reply context until the user accepts (optionally edited)
or rejects them; settled proposals are not proposed again. Acceptance,
correction and rejection retain their existing semantics. The interface shows
running reviews, proposals and uncertain execution. `PSYX_AUTO_REVIEW=false`
disables new review calls.

The review also recommends the stance (talk, analyze, challenge, plan) and depth
(normal, deep) of the conversation's next turn, with a one-sentence reason. A
request whose stance or depth is `auto` (or absent) applies that recommendation,
defaulting to talk and normal before the first review; an explicit choice always
wins. The stream announces the applied stance, depth and reason in a `control`
event before the first token.

A deterministic check (`core/src/domains/psyx/safety.js`) looks for explicit crisis
phrasing in each user message, in French and English. A match overrides the stance
(talk, normal depth, lower temperature), adds a safety instruction to the system
context and streams a `safety` event; the interface then shows Québec resources
(911, 9-8-8, 1 866 APPELLE, 811) as call links. It does not depend on the model.

A new conversation opens with a recap of the last session digest and the open
experiments. The model is told it may connect to them in one sentence and ask how
a planned experiment went, without forcing it.

Normal and deep requests use Core's configured `analysis` and `deep_reasoning`
routes. Review those routes against the accepted PsyX model/host before real
private inference. There is no PsyX-owned provider: a routing failure does not
trigger a PsyX-owned fallback.

Voice remains optional: `PSYX_VOICE_MODE=voix` and an explicit `VOIX_BASE_URL`.
Recordings and synthesized audio stay transient. Browser voice preferences are
request-scoped and never change shared VoiX configuration. The dedicated voice
session uses Core's shared browser transport (`core/public/js/voice`) for local
capture, endpoint detection and playback. It sends completed utterances through
the same private PsyX chat path, requests short spoken replies and resumes
listening after playback. The first browser setup prefers an available female
Canadian French voice from the local catalog, then a female French voice; an
explicit saved choice wins. Pause, closing, navigation and a hidden page
stop capture and cancel browser requests. During PsyX playback the microphone
stays quiet; the visible stop control cancels the session. Crisis call links
remain visible in the voice view. Audio buffers are transient, while completed
text turns remain in the canonical PsyX transcript. Actual microphone,
speech, model and live-device acceptance are separate from the portable tests.

Archive/restore, rename, export, explicit permanent transcript deletion, state
reset and longitudinal experiments remain available. A source response is saved
only after the admitted stream has a terminal result and settled host receipt.
Incoming messages and completed replies are stored whole. Requests exceeding
the HTTP body limit are refused before inference or transcript persistence.
Reply context keeps whole history messages within the local budget (40 messages,
35k characters) or frontier budget (120 messages, 160k characters); omitted
messages are counted in the interface, including after a local fallback.

Memory's Understanding tab projects the approved observations and pending review
proposals with their evidence and source session. The user can correct or remove
any approved statement; corrections retain the original provenance and use the
state revision to refuse stale writes. Older observations explicitly show when
no source session was recorded. Pending proposals stay outside response context.

The Configuration tab checks protected access, local response routes, automatic
review, VoiX reachability and this browser's microphone permission. Only the
explicit microphone test requests capture, then immediately stops every track;
it records and uploads no audio. The frontier row reports whether a frontier agent is configured and the user's mode.

Experiments carry a check-in date (three days by default) and an outcome: worked,
partly, did not work, or not done, which reopens it for three more days. Due
experiments are flagged to the model and in the interface, and the review may
propose an outcome the user reported in conversation, applied only once accepted.
The user can also record 0-10 ratings of how heavy things feel, at the start of a
session or once during a long one; the latest five reach the prompt and Memory
shows their trend.

Every reply also receives the user's own profile (who he is and what he wants
from PsyX, edited in Memory and kept through a memory reset), his goals (a memory
list the review may propose additions to), and the time: the local hour in
`PLANNING_TIME_ZONE`, and how long ago the previous message and the previous
session were. Memory is fitted to the lane's budget by priority (goals, open
experiments and recent sessions before old notes) and always stays valid JSON; a
frontier reply gets a wide budget, a local one stays inside the 16k-character
message contract. The prompt names when to suggest professional help and the
Québec doors for it.

Dream source collection preserves the complete text of each collected note,
task title and mail-journal field. The dream request applies its source budget
once and reports included and available characters in `sourceCoverage`.
Collection still has its existing page limits; these counts describe the
collected material, not every record in the source store.

PsyX can think on a frontier cloud model when the instance names an OpenClaw
agent for it (`PSYX_FRONTIER_AGENT`, with `OPENCLAW_GATEWAY_URL` and its token).
This is an explicit owner choice for PsyX only, never a fallback: each user picks
`local`, `deep` (deep turns, background reviews and dreams) or `all`, the instance
default being `PSYX_FRONTIER_MODE`. Core stays the owner of the conversation and
its memory: every call sends the full PsyX context to the agent under a fresh
session key and expects no memory or tools from it. The agent should have no
tools, no memory search, no injected workspace context and no fallback model.
OpenClaw still keeps its own session record and logs replies on its host. When the
agent is unavailable the turn is answered on the local route and the interface
says so; no other cloud provider is tried. The stance bar always shows where the
next reply is produced.

Between sessions PsyX dreams: once a session has been quiet for thirty minutes,
every night in the 03:00 hour of `PLANNING_TIME_ZONE` when a session moved since
the last portrait (and at least weekly), and on request. A dream selects whole
messages from the newest available conversations, memory, the user's profile and three
read-only owner sources (the notes his assistant keeps, his open tasks and
reminders, the mail journal) and writes a portrait: statements in fixed sections,
each with exact quotations checked against material supplied to that inference,
plus cross-session findings, an agenda for the next
session and the gaps it would like to fill. Unlike the review it writes directly:
it may add memory items (source `dream`) and mark as resolved items the user
neither wrote nor corrected. References record the source kind, conversation and
message index when applicable, and a hash of the source text. The interface can
read the original message, and identifies older quotations as unverified.
Recorded experiment actions/results, check-ins and code-scored questionnaire
records are eligible sources; an experiment's earlier hypothesis is not.
Quotation matching checks provenance, not the validity of an interpretation.
The portrait reports included/available sessions and messages, partial sources
and unavailable sources for the actual inference lane. A latest message that
cannot fit is refused rather than sliced; a cloud failure cannot send its wider
context to a local model.
Every dream is logged and can be undone; a statement the user rejects leaves the
portrait and exact restatements are filtered; semantic paraphrases still rely on
the prompt. A memory reset clears
portrait and log; permanently deleting a conversation discards the portrait and
rebuilds it from what remains, while memory items a dream added stay until removed.
A dream never adds to a full list and filters exact repeats of removed items
recorded in its bounded log. Replies receive the portrait as hypotheses, with
the agenda and the gaps. The dream follows the user's frontier setting, so in
`deep` or `all` the sources above are sent to the frontier agent with the
conversations; in `local` nothing leaves the instance. Core has no calendar or
custody schedule: that rhythm is known only where a note or the profile says it.
`PSYX_DREAM=false` disables the dream.

PsyX offers two standard questionnaires, PHQ-9 (low mood) and GAD-7 (anxiety),
when one was never taken or is three weeks old. The server scores the answers;
no model does. Results stay in PsyX state, are cleared by a memory reset, and
reach replies and the dream as a score, its band and its trend, never as a
diagnosis. Any answer above "never" to the PHQ-9 item on thoughts of death or
self-harm shows the crisis resources at once and tells PsyX to check in. The
wording is the official "French for Canada" translation from phqscreeners.com,
word for word (free to reproduce, translate, display and distribute, as each
form states); `assessments.js` names the source PDF and its SHA-256. Each new
result records the wording version it was answered with. Results saved before
that carry no version: their text was written from memory, not from a form.
A text change gets a new version. The
dream also tracks how much of an intake it knows (situation, goals, family of
origin, relationships, children, work, health, sleep, substances, supports, past
help) and draws its questions from the least-known domains, a question at a
time. `core/src/domains/psyx/techniques.js` holds the technique cards PsyX
offers instead of improvising: a frontier reply receives their steps, a local
one their names, and the interface shows them under Expériences.

`eval/` holds a small set of synthetic scenarios, one per therapeutic skill, and a
runner that builds each reply exactly as the chat does (prompt, stance, state,
portrait, safety check), asks for it on the chosen lane and scores it with
deterministic checks and a judge model grading each criterion. A scenario with
`turns` is a whole conversation: PsyX answers each scripted user turn in sequence
and the judge grades how it was led. Run it against the LAN gateway before and
after a prompt or model change and compare:

    AGENTX_BASE_URL=https://<core> node core/surfaces/psyx/eval/run.js --repeat 2 --out before.json
    AGENTX_BASE_URL=https://<core> node core/surfaces/psyx/eval/run.js --repeat 2 --compare before.json

Reports stay outside Git. The default judge is the router's `deep_reasoning`
model; when it is also the reply model, `--judge-model` gives a second opinion.
`--lane frontier` asks the OpenClaw agent PsyX uses for the replies and
`--judge frontier` for the grades (`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`,
`PSYX_FRONTIER_AGENT`), so local replies can be graded by a model that did not
write them. `--preface` puts a text before the PsyX prompt to test a wording.

## Context and performance

The header opens Core’s shared preferences editor. PsyX keeps its own persisted
settings, independent of Playground, Nestor and Famille. The owner can omit
profile, history, memory, portrait, previous digests, goals, assessments, techniques,
time and confirmed recap context; disable review recommendations or deep replies;
and disable model-generated recap drafts while still writing a point manually.
Review availability and delay, manual/automatic dream availability, idle duration,
local night hour and each read-only dream source are configurable without a restart.
Environment switches supply initial defaults. Saving preferences preserves stored
content, invalidates obsolete background work and leaves crisis safeguards active.

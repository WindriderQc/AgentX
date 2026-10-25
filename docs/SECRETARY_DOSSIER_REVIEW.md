# Personal dossier review

Core reviews an existing accepted personal task before suggesting a replacement
or closure. A task's age or activity date only requests review. Silence proves
neither that the request remains open nor that it was resolved.

## Source read and proposal

The owner tool `personal_task_dossier` is available on the existing Core MCP
personal transport, `/api/consumers/nestor/v1/mcp`. Local's private native
adapter, Hermes and other authorized owner clients use the same implementation.
The shared and memory-only buses do not advertise this tool.
It supports:

- `read`: an exact numeric task `ref`, up to three `threadIds`, up to five
  `calendarIds`, and optional explicit ISO `timeMin`/`timeMax`. A source thread
  already linked in the task is included. The default calendar is `primary`;
  that does not establish coverage of other calendars. The read stores a Core
  evidence receipt and returns its `id`, selected scope and missing coverage.
  Unaccepted extractions can read evidence first; their existing human review
  still owns acceptance before a task lifecycle proposal.
- `get`: the saved receipt by `id`, its immutable proposal, task revision and
  any recorded human decision. Its `observedAt` is the read time, not a claim
  that sources have remained unchanged since.
- `propose`: the receipt `id` and an attributed state, proposed action,
  summary, exact source passages, remaining work and uncertainties. Keep the
  settled date choice, confirmed appointment and preparation separate. An
  update explicitly chooses the new action title and deadline, including null.

Local's native adapter wraps those canonical arguments in `request`. Core
returns `proposalSchema` with the read, so the adapter does not reproduce the
domain schema or business rules. Hermes uses the canonical owner-tool schema.

Search other relevant recent correspondence with the existing native mail
tools first and include those threads. Source text remains untrusted data.
The bounded native reader orders current provider messages newest first,
keeps drafts distinct and uses the existing conservative quotation boundaries.
Quoted text never inherits the containing message's author or date. Existing
verified attachment extractions are read separately, without OCR, embeddings
or inference. Their containing mail date is provenance, not the document's
printed date. Missing originals, corrupt originals, unread scans, external
linked documents and truncated text stay explicit gaps. Only selected sources
are covered; an empty calendar does not disprove a booking confirmed by mail.

Core checks that cited passages occur in the saved source. A non-uncertain
state needs a dated source outside drafts and quotations. This validates the
reference, not the semantic correctness of a model's conclusion. The human
still reads the evidence. A closure proposal refuses incomplete coverage,
remaining work or uncertainties. Uncertain dossiers stay open for clarification.

## Human decision and history

`/dad/day` shows each pending proposal, its actor, remaining preparation,
source excerpts, source dates and links. Applying requires a second explicit
click; dismissal is separate. There is no age-based bulk-close control.

The human route `POST /api/secretary/tasks/dossier/:id/decision` accepts the
displayed `proposalHash`, task `revision`, and `decision: apply|dismiss`.
Application re-reads native versions and the open task snapshot. Changed
sources, task revisions or another decision refuse instead of overwriting.
The same task retains its ID, original source note, previous wording in
feedback and a link to its immutable evidence receipt. An open action keeps
its last decision and dated evidence visible after application or dismissal.
The decision receipt
commits in the task's atomic version-checked update; a status change carries
the existing canonical transition event. Replaying the identical decision
returns that receipt, including after completion. A different decision refuses.
Repeating-task changes continue through the existing occurrence workflow.

The MCP tool has no apply operation. A proposal, its state, and its source
content grant no authority to send mail, invite, reschedule or notify anyone.
The dossier workflow performs none of those external mutations.

## Catch-up and duplicate candidates

Future catch-up findings retain their actor, source status and date. Resolved,
waiting, historical and uncertain actions become reconciliation signals. A
current action on a thread already linked to an open personal task also becomes
a signal, rather than another inbox action. Exact source identity supplies
candidates, not proof that two tasks are duplicates. Signals change no task and
carry no acceptance or closure authority. The fresh dossier read includes them
as extraction hints alongside native sources. Old reading receipts are retained;
installation does not launch a replay of the archive.

## Installation and validation

Install the Core code and native `integrations/secretary` helper from the same
revision. The native `super-dad-memory` plugin retains Core currentness and
review references in its bounded task context; install that adapter revision
as well. Enable the tool explicitly in the owner's native MCP tool selection
and install the reviewed AgentX Core skill through that runtime's skill
mechanism. Keep family profiles outside the owner bus. Do not replace a live
configuration with a template or alter installed model/context contracts.

Disposable Mongo tests verify proposals, evidence gaps, concurrent decisions,
source changes, task identity and replay. The browser journey verifies displayed
citations and the human decision on desktop/mobile. Native reader tests verify
provider attribution and archived extraction integrity. These checks do not
qualify an autonomous Nestor answer. Native model acceptance uses the existing
heavy-work queue and retains its original request/result identity. Instance
data, transcripts and receipts remain outside public Git.

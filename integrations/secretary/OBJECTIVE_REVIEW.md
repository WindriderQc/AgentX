# Versioned archive reading objectives

`objective_review.py` reuses Secretary's native Core client and durable attempt
fences for a new, explicitly versioned reading goal. General page reviews are
preserved. It does not send mail, mutate mailbox state, publish personal tasks,
confirm memories or create souvenirs. Code tests do not establish live model
quality or exhaustive interpretation.

New objective versions freeze `secretary.objective-attribution/v1` in the
manifest and objective hash. They reuse `secretary.source-context/v2` for
depth-aware quoted headers, full segment extents and boundary text across
continuation pages. Original bytes, representation hashes, page ranges and the
page identity algorithm remain unchanged. Existing manifests without that field
keep their original system/prompt identity, v1 context and receipt replay;
neither installation nor status starts another reading or upgrades an uncertain
attempt. Selecting a new objective version is explicit.

Private `attribution-index/` and content-addressed `attribution-evidence/` retain
the exact unchanged representations used for reconciliation. Their hash binds
the source record and the receipt's `quoteAttribution`; receipt reads replay
that derivation. Rejected-copy scopes and complete-text aliases use the same
frozen context. No evidence or model response is rewritten. A container date or
sent-owner reading cue is unavailable on a mixed/quoted page; literal source
dates remain distinct from interpretation of the event.

Each exported quote retains author/date claims separately from verified
original matches, original-body Unicode spans, containing-message provenance,
later message references and stable assertion/quote keys. Core imports these
reading signals as timeline metadata, keeping exact quotes and candidate state.
Only verified selected originals in the same native Gmail thread can establish
a match. Missing originals, conflicting MIME alternatives and Outlook exports
without a canonical thread identity remain unresolved; no reply association is
guessed. Later answers need not repeat the quotation to require reconciliation.
Repeated quotations are not independent testimony. These signals establish
neither current requests, the containing sender's obligations nor business
resolution; they neither merge facts nor change historical campaign validity.

`secretary.objective-quote-reconciliation/v1` withholds another automatic
proposal when a new finding cites exactly the same complete set of assertion
keys within the same objective version, source system and native thread. It
does not compare topics, actors or inferred business meaning. Distinct sets and
partly shared sets remain separate interpretations. Every raw result, receipt
and exported finding is preserved; `withheld-repeat` points to the frozen
canonical finding for source review. The first exported identity stays fixed
when an original is read in a later chunk. The publisher validates that link,
retains the withheld records in its proof manifest and
`publication-plan.json.withheldForReconciliation`, and creates no second Core
proposal for them. This gate never merges interpretations or establishes that
a request is resolved. Objectives under the earlier contract retain their
existing publication behavior.

New objectives use `secretary.objective-grounding/v14` for model extraction.
Each passage supplies a deterministic `citationCatalog` of exact nonempty lines
and source offsets. The response schema restricts `citationIds` to that page;
local validation resolves each ID back to the original span. The model selects
evidence rather than transcribing a quote. Unknown or duplicate IDs, missing
evidence and a response that ignores the frozen contract fail closed.

`professionalCueCatalog` enumerates explicit work reports and deliveries beyond
career milestones. Every listed anchor requires its own `professionalDecisions`
entry: `retainedMoments` with that anchor's work type, or a `reasonRef` among its
source-supported omission choices. Complete reports in an owner reading context
cannot silently disappear or be dismissed for unknown event dates. Other or
unresolved actors, conditional statements and non-biographical contexts keep
cited omission paths. Additional facts and context observations cannot bypass
these decisions. The catalog is a reading aid, not a claim of usefulness or truth.

`actorReadingCatalog` conditions proposed subjects on each primary excerpt's
reading context. Unresolved speakers require `subject: unknown` and an empty
`subjectName`; a recipient, familiar greeting or following header supplies no
owner identity. Complete literal declarations can remain useful with unknown
actors and are not erased solely for that uncertainty. Other-speaker headers
permit third-party or unknown readings, never owner attribution. Even an allowed
owner reading is a proposal, not identity verification. This applies during
schema generation and local validation, with immutable native choices and
source context in the `workActorSelection` proof. Rejections are never repaired
or retried to fill the required decisions.

Each native fact selects `sourceClaimType`: `direct-source` for an explicit source
report or announced plan, and `interpretation` for a proposed reading beyond what
the source explicitly states. The canonical `claimType` is the fixed mapping to
`direct` or `hypothesis`; there is no independent native confidence selector.
`sourceClaimCatalog` preserves complete declarations and their speaker reading
context. Those anchors require `direct-source`, in both generation and local
validation. Unknown dates or pending personal review do not make an explicit
source statement an interpretation. Genuine questions, conditional plans,
possibilities and incomplete wording retain their conservative interpretation
choices. A quoted or unresolved speaker does not make an explicit first-person
statement an interpretation; actor uncertainty stays in its own fields and source
context. Reading context does not verify identity. Local reservations, planned
status, date gaps, human review and lack of personal confirmation remain separate.
The `claimTyping` proof retains native choices and exact source context; the
anchored-fact proof distinguishes those choices from its derived legacy inputs.
Old responses are neither retyped nor repaired, and invalid new choices are
retained as rejections without another inference call.

Useful facts include explicit personal career steps at their stated stage:
`career-contact`, `application`, `interview`, `job-offer`, `employment-change`,
`work-activity`, `work-correspondence`, or the generic `life-event`. Contacting a firm and sending a CV can be retained
without implying hiring, a later interview or a new employment period.
`selectionCues` includes bounded lexical reminders for career steps and personal
home, travel, leisure, study, family, health and planned-project wording. Personal
pronouns do not identify the owner: quoted text, newsletters and other actors
still need review. These cues are not events, proof of occurrence or an exhaustive
inventory. No place-name dictionary or instance-specific example is required.
Undated/relative-date travel and planned personal activities can remain useful;
missing absolute dates alone do not justify omitting them.

Every cue is a required property in `cueDecisions`, keyed by its citation ID.
It selects either `retainedMoments`, containing complete native fact metadata
anchored in that cue, or its own `reasonRef` from `omissionReasonCatalog`.
Each fact selects `anchorCitationId` and `qualificationIds` for its primary
excerpt; `contextObservations` contains useful non-cue context without repeating
the primary anchor. Optional facts anchored in non-cue excerpts are in the root
`additionalMoments` array. There is no arbitrary moment index, independent title
selector, parallel cue observation list or `omittedCues` model field. Unknown,
cross-cue, duplicated, overlapping or silently ignored cue decisions fail
closed. A lexical match can still be omitted with source-backed proposed reasons;
it never automatically creates a fact. The canonical gaps retain the reason and
complete source excerpts for review. Career cues retain their frozen legacy
projection as well; prior results are neither rewritten nor reinterpreted.
Missing decisions, cross-cue anchors and source-context bypasses are
rejected without adding an observation, creating a moment or retrying inference.
`anchoredFacts` in the projection proof preserves the native selections and their
exact bindings; `derivedCueBindings` explicitly labels the bridge to the frozen
projection as derived rather than native wire data. A cue can support several model-proposed moments when its source
excerpt actually supports each; source review still verifies that interpretation.

Every empty extraction also requires `abstention: {reasonRef}` selecting an
actual whole-passage catalog option, including administrative passages without cues. The
response schema separates positive extractions (`abstention: null`) from cited
negative and uncertain decisions. Ambiguous actor or insufficient event context
requires `emptyAssessment: uncertain`, not a confident no-event classification.
Only an actually empty passage permits `no-readable-source` and no citations;
there is no selectable absence marker. A missing event date is not an allowed
reason. Proposed reasons are not semantic proof: source review can still find
an unjustified abstention. The canonical summary displays its reason and whole
supporting excerpts, or refers to their complete gap text when they exceed the
summary bound. `selectionReview` retains the exact source spans and cue decisions.

The source-conditioned reason catalog is a conservative admission policy, not
a semantic classifier. Personal reading cues cannot be confidently dismissed
as administrative; a document marker elsewhere cannot justify that omission.
Administrative whole-passage negatives require a literal administrative marker
and no unresolved personal cues. Non-biographical cue reasons require explicit
local promotional/fictional context, with lexical negations conservatively
blocking that option. Uncertain actor/context alternatives remain available;
they create neither an event nor a confident no-event decision.

A proposed other-person cue reason retains both the cue and its nearest preceding
quoted author header. A following header, an owner alias in that header, or absent
owner aliases makes that option unavailable. This is quoted-speaker context only,
never verified authorship or proof that every unmatched name is another person.
Aliases come from the immutable objective for schema generation, projection and
receipt/disposition replay. `omissionPolicy` retains the chosen catalog entries.
Source review still assesses their relevance; a valid reason reference is not
semantic acceptance. No rejected output is rewritten or automatically retried.

`declarationCatalog` identifies a conservative subset of complete first-person
source declarations, with their exact speaker reading context. A sent container
at offset zero or a preceding owner-alias header supplies a reading cue, never
verified identity. Quotation boundaries, unknown/continuation speakers,
questions, negations, reservations and promotional wording keep their omission
paths. Unrelated or later headers never supply that context.

For a complete declaration in owner reading context, blanket `ambiguous-actor`
and `insufficient-event-context` omissions are unavailable. An absent absolute
date does not erase a reported activity or completed event. The model must keep
the useful exact observation, possibly within an existing event; local code
never invents a proposal or identifies its actor. These conservative lexical
guards remain subject to source review and do not cover every possible wording.
A complete home declaration has its own reported `life-event` in category
`home`; it cannot borrow a professional fact's type or communication date.

A complete explicit upcoming activity also retains its initial `planSpan`.
A later sentence warning of a conditional risk does not erase that plan or its
speaker reading context. Retentions of these plan cues must remain `planned`;
they cannot become reported attendance. Genuine conditional plans, questions,
negations, promotional wording and unknown speakers keep their conservative
omission paths. The whole original source line is retained, including warnings.

Summaries have no independent global excerpt selector or observation flags. The
application selects at most the first three distinct retained title excerpts,
which belong to those facts’ own observations, and copies them whole in source
order into the canonical summary. An omitted cue cannot reappear through
a separate summary citation list. Empty extractions still display their cited
abstention reason locally. `declarationSelection` and `retainedSummary` retain the
reading cues and selection proof for native-result replay.

The model selects a proposed `factType` conditioned on its primary anchor's
matching `factTypeCatalog` entry. There is no independent model
`factTypeCitationIds` selector. The local projection derives type evidence only
from that same explicitly selected primary anchor; neutral `life-event` uses an
empty derived list. A code delivery or post-contract
follow-up is not an employment transition. These lexical cues can contain
questions, negation or third-party wording; they never certify a fact's type.
Local labels say that the proposed nature requires review.

Each available fact type has a complete, disjoint response-schema alternative.
Professional alternatives require matching primary anchor IDs and category
`work`; neutral `life-event` requires an empty type-evidence list. Communication
date references appear only in the start choices of contact, application and
work-correspondence alternatives. End dates and underlying activities cannot
select them. Local validation retains these checks even if a backend ignores
the schema. Event-date association within observations still needs review.

Dates select `startDateRef` and `endDateRef` from `dateCatalog`, or null. The
model cannot supply canonical date values, precision or `originalDate`. The
local catalog preserves literal, calendar-valid French, English and ISO date
expressions at their actual precision and exact source offsets. An event date
must occur in that moment's own observation citations. Retained message metadata
and recognized mail headers are communication dates: only a career contact,
application or work correspondence may select one as its start date, with an
explicit limitation. They cannot date an underlying move, trip or work activity.
No relative-date calculation, missing-year completion or day-to-month rounding
is offered. Bare date lines have no event association. Matching an event date
within a cited line still requires source review for the actual association.

The model supplies no free `uncertainty` field. Local
projection assembles concrete limits: scope of a contact/application/offer,
missing event date, unconfirmed realization of plans, unknown or third-party
actor, explicit cited uncertainty, and partial character range. Every proposal
retains its source-only and unconfirmed status. Scope comes from the retained
source record and is replayed when receipts are read, not guessed from prose.
Other documents and representations outside the passage remain unqualified.
Labels such as `low` or `high` cannot replace these limits. This explanation
does not infer truth, prove that an observation follows from its citation or
establish exhaustive recall.

Current summaries derive their excerpts from retained title observations. Frozen
v2–v9 responses retain their independent `summaryCitationIds` projection.
Core-compatible summary text reports the extraction state and quotes
whole source lines in source order, without assigning them to the container's
author. Negations, conditions and draft/latest wording are preserved. If the
selected lines cannot fit the 2,000-character summary bound, the summary reports
only the extraction state and refers to the complete observations/citations;
it never shortens a clause. The selected spans and fallback reason remain in
the verified projection receipt.

Each proposed event selects exact source observations, with no generated prose.
An observation has one `citationId` and at most one `qualificationIds` reference
from that same source line. Its title selects `titleCitationId` from its own
observations. The application copies complete source wording, preserving relative
days, future expectations and negation in both titles and descriptions. A title
that would exceed its bound uses a neutral type/category label and refers to the
complete excerpts; it never cuts a clause. Long rationales refer to the complete
description instead of shortening an excerpt. The model supplies no `ongoing`:
automatic historical readings do not assert continuation through today.

`uncertaintyCatalog` binds a complete source line to its category (`question`,
`condition` or `possibility`). Its conservative French/English clause gate excludes
isolated `si`/`if` name tokens and recognized indirect questions; it is not a full
parser and can miss unusual wording. Only real catalog references are selectable.
The response schema separates observations by their available local references;
local validation rejects a reference attached to another excerpt even if the
backend ignores the schema. An empty catalog requires empty local selections.

Canonical rationale and relation hints label each reservation with its exact
excerpt and source-only scope. There is no model-generated event-wide hypothesis
array. A condition on future help does not make other cited completed work
hypothetical, and a possibility quoted in one observation does not become global
uncertainty. The application neither answers the reservation nor certifies its
realization. Its binding, source offsets and local rendering remain in the
verified projection receipt. Human review still checks whether excerpts belong
together and whether a local reservation is useful for the proposed event.

Automatic subject attribution is limited to `owner`, `thirdparty` (another
person) and `unknown`. The model cannot certify someone as a close person
(`related`), even if a backend ignores its schema. Close-person classification
requires human review. Explicit relationship wording can remain a cited source
observation; an exchange or familiar salutation grants no proximity. The
canonical schema still supports `related` for historical and reviewed results;
old results are neither downgraded nor reinterpreted.

The rationale is assembled locally from the separate observations and labelled
source uncertainty. Instructions also exclude unsupported status, ownership,
certification, completion and author-attribution claims in other fields. These
controls do not prove semantic entailment: a model can still group unrelated
excerpts, misclassify an actor/event, or select a question answered elsewhere. Source
re-reading and owner review remain necessary before publication.

The extraction response has no independently generated `classification`.
The application derives `life-events` from a nonempty event list; only an empty
list uses `emptyAssessment` (`no-life-event` or `uncertain`). It never changes a
contradictory retained legacy classification to make it pass validation.

Native responses stay immutable. `resultProcessing` records the source-span
projection and claim mappings, which are recalculated when receipts are read,
including after an interrupted local projection. The canonical result and
publisher contracts stay the same. Legacy canonical receipts and frozen
`secretary.objective-grounding/v1`, `/v2`, `/v3`, `/v4`, `/v5`, `/v6`, `/v7`, `/v8`, `/v9`, `/v10`, `/v11`, `/v12` and `/v13` responses retain their original
projections, schema fingerprints and change descriptions. Each frozen grounding
version requires its own verified projection; an old contract cannot bypass the
new attribution controls.
Changed prompt/schema hashes require a new objective version; no prior objective
or rejection is rewritten. This extraction contract grants no publication or
owner confirmation and does not relax a campaign's existing review gate.

The first supported objective is `life-timeline`. Its private JSON configuration
contains `id`, `version`, `kind`, explicit `ownerAliases`, optional `instructions`,
`pageChars` (default 6000), `overlap` (300), and optional `selection`:

```json
{
  "id": "life-timeline", "version": "v1", "kind": "life-timeline",
  "ownerAliases": ["Synthetic Owner", "owner@example.test"],
  "selection": {"gmailMessageIds": ["message001"], "outlookSha256": []}
}
```

Omitting a selection array includes that native source system; an empty array
excludes it. Optional `selection.order` contains `gmail:<id>` or
`outlook-export:<sha256>` keys for a representative pilot. Native Outlook
conversion files and their existing Gmail/RFC links remain explicit. Copies,
quoted chains and MIME alternatives do not establish independent testimony.

`plan` freezes the objective, prompt/schema hashes and archive source inventory
without a model, MIME parse or hash-verification pass. A changed configuration,
prompt or schema under the same version refuses; use a new version. The source
inventory is a snapshot: later arrivals require explicit new planning. Metadata
planning cannot know the full page count before source materialization.

```sh
python3 integrations/secretary/objective_review.py plan --objective "$PRIVATE_OBJECTIVE"
python3 integrations/secretary/objective_review.py status --objective "$PRIVATE_OBJECTIVE"
```

Before `run`, obtain an operator dispatch through Core's
[heavy-work queue](../../docs/HEAVY_WORK_QUEUE.md), link the session/issue,
declare hosts/duration/window and retain native coordination and admission.
The worker asserts the exact queue dispatch before source work and each live
call. It never chooses a concrete model or changes a host pin. `mail_review`
uses Core's configured task route. A pilot should bound pages, time and pages
per source; Core retains final inference admission.

Optional private `thinking: true` requests Core's native reasoning channel for
this objective. Omitted/false retains the inherited non-thinking request and
legacy dispatch identity. Enabling it enters both the immutable objective
manifest and the dispatch intent; a changed mode cannot replace a retained
attempt. The worker refuses a client whose mode differs from its manifest.
Use a distinct objective version for changed instructions or reasoning mode,
preserving old page receipts and raw results. This option chooses no model,
host pin or context, performs no profile/load, and establishes no semantic
quality by itself. A live comparison still needs native queue/admission and
source-level output review before publication or a larger campaign.
For bounded schema extraction, prefer `thinking: false`: hidden reasoning can
finish without any visible JSON. This is a request policy for Secretary, not a
change to Core's model/context pin or another agent's reasoning mode. Changing
it requires a new objective; never use it to reissue a retained empty response.

```sh
python3 integrations/secretary/objective_review.py run --objective "$PRIVATE_OBJECTIVE" \
  --max-pages 16 --max-pages-per-source 1 --max-seconds 1800 \
  --queue-request-id "$QUEUE_REQUEST_ID" --queue-dispatch-id "$QUEUE_DISPATCH_ID"
```

Run the same objective again to resume. A completed page is replayed from its
native receipt. An uncertain dispatch blocks replacement; reconcile the exact
saved attempt, never delete a fence. Invalid output keeps its original result
and refuses a new model call. Native source corruption refuses reading.

The native client saves the received HTTP text before parsing its envelope,
then saves the exact model text and output limits before parsing that text.
Both private captures have hashes and retain the request/intent identity.
Received malformed or length-limited output is a known validation failure;
an empty or whitespace-only final is explicitly `empty-model-content`, never a
valid abstention, empty object or JSON parse error. Hidden reasoning is never
promoted into the final answer. Exact empty bytes and usage remain retained,
without assuming a token limit or diagnosing an upstream cause from absence.
transport loss or failed durable capture remains uncertain. Neither failure
permits an automatic replacement call. An incomplete generation is rejected
even if its final JSON happens to parse.

`--max-output-tokens` explicitly requests a bounded Core output budget through
`options.num_predict`; it never changes the host pin, context or model choice.
Campaigns can pass `maxOutputTokens`. The option enters the dispatch intent:
changing it cannot silently replace a failed prior request. Completed page
receipts remain readable under their original identities.

An unusable response can receive an explicit, bounded linked retry after its
native computation and queue release are reconciled. `review_recovery.py` does
not run inference. It verifies the original intent/request identity, Core's
exact successful InferenceLog, a terminal operator queue with its native release
receipt, the exact terminal/status byte hashes and absence of active runtime
claims. A missing log, active claim, mismatched page/request, uncertain release
or retained structured result refuses the operation. Original attempt and
response files remain untouched; a structured result must be recovered instead.

```sh
python3 integrations/secretary/review_recovery.py record-terminal \
  --directory "$NATIVE_OBJECTIVE_DIRECTORY" --page-id "$PAGE_ID" --request-id "$OLD_REQUEST_ID" \
  --queue-id "$OLD_QUEUE_ID" --inference-log-id "$INFERENCE_LOG_ID" \
  --terminal-receipt "$EXACT_OPERATOR_RECEIPT" --worker-status "$EXACT_WORKER_STATUS" \
  --reason "$RECONCILIATION_REASON" --authorization-ref "$SESSION_TASK_REFERENCE"
python3 integrations/secretary/review_recovery.py authorize-retry \
  --directory "$NATIVE_OBJECTIVE_DIRECTORY" --page-id "$PAGE_ID" --request-id "$OLD_REQUEST_ID" \
  --max-output-tokens 8192 --reason "$RETRY_REASON" --authorization-ref "$SESSION_TASK_REFERENCE"
```

The immutable retry plan derives a new identity from the unchanged source,
prompt/system/route and explicit output budget, linked to its parent's request
and terminal-reconciliation hash. Changed source/policy/budget refuses; no retry
is automatic. An admitted worker with the matching budget creates a separate
`retries/<intent-hash>/` attempt. Its uncertain result blocks the entire next
batch. Retained child results and representation derivations replay without an
additional model call. Eight chain traversal steps bound recovery complexity.
The ordinary Core queue/dispatch and live inference admission still apply to
each later run; a retry plan grants neither a reservation nor admission.

The local representation adapter may change a missing date's precision from
day/month/year to `unknown`. It can also restore a quote's exact original
whitespace when every non-whitespace token and punctuation mark is identical
and all matching source spans contain one identical original string. Repeated
positions of that string are accepted without adding testimony; distinct
original whitespace variants remain ambiguous and are rejected. This covers
CRLF/LF, tabs and nonbreaking spaces without fuzzy text matching.

The adapter never fills a date or repairs an attribution, occurrence or factual
interpretation. The source and native model result remain intact; a separate
processing receipt names the raw result hash, each changed path and the exact
source spans for restored quotes. Receipt reads replay and verify this
derivation. A complete result rejected solely for these representation
differences can resume without another inference or a different
objective/prompt identity.

The worker verifies original bytes and reuses the native inert MIME reader:
every inline plain/HTML representation and available HTML supplement is a
separate bounded scope. It reuses existing attachment text only; no new OCR,
render, decompression or linked-resource fetch occurs. Missing, clipped,
visual, nested and OCR-quality scopes remain explicit gaps. Metadata describing
an image or attachment is not evidence that its content was seen.

If a source plan repeats the exact same representation scope, its generated
page IDs occur once in the unit plan. The physical representation entries stay
preserved, and separate MIME parts, hashes and offsets retain their distinct
identities. This prevents duplicate generated IDs from invalidating full-unit
rejection checks without changing original sources or historical receipts.

The inert reader resolves the declared `windows-874` charset through Python's
`cp874` codec using strict decoding and records that derivation in the text
representation. Unknown charset names and invalid bytes remain unreadable;
no encoding is guessed. A source plan with no readable page is revisited on
resume, so this reader correction needs neither an archive mutation nor a
reset of completed review receipts or the objective identity.

The same MIME reader extracts text from `application/rtf`, `text/rtf`,
`application/x-rtf`, and explicitly named `.rtf` octet-stream parts. It verifies
the RTF signature after MIME transfer decoding and uses unchanged vendored
striprtf 0.0.34, with its distribution/source hashes and BSD-3-Clause license
in `_vendor/striprtf/UPSTREAM.json`. A disposable local Python child limits CPU
to two seconds, wall time to three seconds, address space to 128 MiB and input
and output to 1 MiB each. No office engine, document code, network resource,
image render or new OCR runs.

The supported profile is ASCII RTF syntax with strict codepage escapes and
Unicode controls. Valid UTF-16 surrogate pairs are combined; unsupported raw
8-bit text, unknown codepages, malformed structure/controls, binary payloads,
fields and omitted text destinations remain explicit unreadable gaps. Hex
images/objects can retain the surrounding text but remain visually unqualified.
No missing text is guessed or silently replaced. Extracted text carries the
part index, MIME type, filename/disposition, decoded binary hash, processor,
version, profile and text hash. The archive API labels its scope as a selected
RTF text part, never a whole-message or visual reading.

An older plan that knows an RTF document but has no current RTF profile is
rematerialized before either completed-page fast path. Its old header unit is
retained byte for byte and the newly extracted RTF unit has new page identities.
Existing receipts, request fences and the frozen objective/prompt remain
unchanged. Until rematerialization, or while known RTF text remains opaque,
source-level `textReviewComplete` and `textCovered` stay false; actual header
page receipts remain counted. The plan stores the current reader profile without changing historical source
metadata. A failed extraction stamps the current profile
and its reason, so later runs do not reparse that same known failure forever.
Native complete-text equivalence can cover the new representation only after
its text and message context are verified; it never counts as another model
read or independent testimony.

Private results live under `objective-reviews/<id>/<version>/`: immutable
`manifest.json`, native `review-attempts`, per-source plans, per-page exact
passage receipts, `status.json`, `coverage.json`, `findings.json` and
`sources.json`. Exported candidates carry original/representation hashes,
native identities, offsets, exact quotes, owner/related/third-party attribution,
event start/end and date precision, occurrence status and proposed relation
hints. Source date remains distinct from event date. No candidate is confirmed.

Complete units with the same whitespace-folded text and the same author,
addressee, date, subject, RFC identity and draft context can reuse an existing
objective review. Attachment units also require the same binary/extraction
identity. A unit is registered only after all of its canonical pages have
validated model receipts. New text variants remain pending. An equivalence
receipt retains the alias's original/representation hashes, maps every claim
back to an exact quote in that copy, and points to the actual canonical reads.
It adds source provenance to the same candidate, not another fact or an
independent agreement.

`reviewedPages` and `sourcesTextReviewed` count only actual model page receipts.
`equivalentPages` and `sourcesTextCovered` separately describe verified text
equivalence. `allTargetTextCovered` can be true while `allTargetTextReviewed`
is false; neither establishes semantic acceptance or human confirmation.

With the explicit review-only `--retain-rejected-pages` policy, a complete unit
whose every page has an intact, certainly terminal rejection can defer exact
copies. `rejected-copy-index/` seals that canonical unit and its rejection byte
hashes; `rejected-copy-reports/` records each target page separately. These are
neither accepted equivalences nor new rejected model outputs. No result, fact,
quote or source record is transferred to exports.

The objective, nonempty RFC identity and existing equivalence context must
match, including author, recipients, date, subject and draft status. In addition,
the complete unit bytes, representation scope, page ranges and attribution
context must match exactly. Whitespace-only variants do not qualify. MIME part
numbers may differ between physical copies; attachment/extraction/decoding
identities cannot. Partial or mixed accepted/rejected canonical units remain on
the ordinary review path. Every report rereads the canonical rejection and all
sealed native response artifacts. A changed proof or conflicting target review,
rejection or attempt blocks explicitly. An existing target attempt always keeps
its own native recovery path; a report cannot bypass an uncertain call or a
known invalid cache. Reported objectives cannot silently resume without the
explicit retention policy.

`deferredRejectedCopyPages` and `sourcesWithDeferredRejectedCopies` are distinct
counts, with `modelRead: false`, `textCovered: false` and an explicit source gap.
They never increase `reviewedPages`, `rejectedPages`, `equivalentPages`,
`sourcesTextReviewed` or `sourcesTextCovered`. Annual coverage reflects only
their remaining gap; it gives no new rejection/read credit. Newly written
reports share both the chunk and per-source page budget with accepted and
rejected pages. Once every target is visited and only uncovered gaps remain,
the campaign's existing `needs-source-review` terminal state prevents empty
continuation chunks. This behavior changes neither a saved rejection nor its
source and never retries a model request.

Coverage distinguishes target sources, materialized scopes, validated page
receipts, remaining known pages, sources not yet materialized, extraction gaps
and semantic acceptance. A fully read text scope does not qualify images,
prove a complete live mailbox, or establish the truth of the interpretation.

`secretary_mail_desk.py catchup` reads content-free `archiveProgress` from
`native-status.json` and `objectiveReviews` from the generated objective
coverage/status receipts. Core preserves these at
`GET /api/secretary/desk` → `data.mail.catchup`. Existing catch-up counters
continue to describe the last general run, not all reviewed archive pages.

Objective exports also retain `annualCoverage` (`secretary.annual-source-coverage/v1`):
at most 512 observed mail-header years, a separate unknown-date bucket, and
Gmail/Outlook totals. Each physical target remains counted, including copies.
`targetedSources`, `availableSources`, `reviewedSources`, `coveredSources`,
`rejectedSources`, `gapSources`, `sourceErrors` and `metadataErrors` are separate,
potentially overlapping source counts. Year/system totals must reconcile.

The year comes from a materialized source's `mailDate` bound to the frozen
source identity, the Outlook container's archived RFC Date, or Gmail's existing
thread-manifest Date header after matching its exact message/thread and native
raw receipt path/hash to the frozen inventory. Missing, invalid or mismatched
metadata stays unknown. Gmail provider milliseconds, retrieval time, filesystem
mtime and extracted life-event dates never supply this year. Calendar years
retain the header's timezone rather than shifting a December date into January.
Availability checks only presence and expected byte size, never attest integrity.

The aggregate is calculated at plan/export time and written with the existing
atomic coverage receipt. Desk reads project that stored aggregate without
opening all source files; both Python and Core retain only bounded count/year
fields. The Atlas popup fills empty view/life years through today, retains
observed years outside the displayed range, and shows unknown dates separately.
This inventory/reading view stays distinct from the density of loaded moments,
semantic acceptance, owner decisions and the factual chronology of a life.

## Publishing candidates to Core

After the worker releases its lock, `objective_publish.cjs plan` validates every
candidate with Core's existing personal-history context contract. `publish`
sends one atomic context import at a time through
`POST /api/secretary/history/context/import`, with an explicit write budget:

```sh
node integrations/secretary/objective_publish.cjs plan \
  --directory "$NATIVE_OBJECTIVE_DIRECTORY" --core "$AGENTX_CORE_URL"
node integrations/secretary/objective_publish.cjs publish \
  --directory "$NATIVE_OBJECTIVE_DIRECTORY" --core "$AGENTX_CORE_URL" --max-entries 20
```

Stable import IDs and per-payload intent/response receipts reconcile the native
entry and `contextHash` before any retry. An uncertain result with no exact
Core receipt blocks replacement. Additive context enrichment uses Core's
current context revision, retaining owner overrides, review and souvenir state.
The write budget counts actual posts; already reconciled entries do not prevent
later candidates from advancing on the next invocation. Existing-source facts
with a shared exact passage can receive proposed hypothesis links; the publisher
does not merge them or rewrite an earlier assertion.

The local files are execution and recovery evidence. Core's existing owner
history remains the authority for candidates and human decisions; the publisher
creates no souvenir and never confirms an assertion.

A source audit may supply `--adjudications "$PRIVATE_AUDIT"` on the first plan
and publication. Each item names `findingId`, `clear` with `"start"`, `"end"`
and/or `"ongoing"`, an explicit `reason`, `question` and `reviewedAt`. This
bounded operation can only clear an unsupported event date to unknown or remove
an unsupported claim of continuation through today. Clearing `ongoing` preserves
the known start and unknown end, without inventing a departure date. It retains
the exact model date proposal and rationale in `timeline.metadata.dateReview`, labels the
audit as automatic, and publishes the corrected candidate on its first write.
Quotes and occurrence/subject claims remain unchanged. The private input is an
execution intent, not a lasting decision authority: future publication reads
the adjudication from Core and preserves it without that file. A different
native adjudication detected after planning blocks enrichment until reloaded.

Every automatic `ongoing: true` proposal is additionally bounded to its source
context before publication: the imported candidate has `ongoing: false` and an
unknown end, with an explicit caveat and review question. Metadata preserves the
model's ongoing/end proposal, uncertainty, source identity and container date;
that date does not replace a quoted declaration's own date. No historical
"currently" establishes continuation through today. Core's retained owner
overrides remain authoritative over the descriptive imported timeline.

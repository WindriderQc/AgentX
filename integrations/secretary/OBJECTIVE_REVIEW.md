# Versioned archive reading objectives

`objective_review.py` reuses Secretary's native Core client and durable attempt
fences for a new, explicitly versioned reading goal. General page reviews are
preserved. It does not send mail, mutate mailbox state, publish personal tasks,
confirm memories or create souvenirs. Code tests do not establish live model
quality or exhaustive interpretation.

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

```sh
python3 integrations/secretary/objective_review.py run --objective "$PRIVATE_OBJECTIVE" \
  --max-pages 16 --max-pages-per-source 1 --max-seconds 1800 \
  --queue-request-id "$QUEUE_REQUEST_ID" --queue-dispatch-id "$QUEUE_DISPATCH_ID"
```

Run the same objective again to resume. A completed page is replayed from its
native receipt. An uncertain dispatch blocks replacement; reconcile the exact
saved attempt, never delete a fence. Invalid output keeps its original result
and refuses a new model call. Native source corruption refuses reading.

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

Coverage distinguishes target sources, materialized scopes, validated page
receipts, remaining known pages, sources not yet materialized, extraction gaps
and semantic acceptance. A fully read text scope does not qualify images,
prove a complete live mailbox, or establish the truth of the interpretation.

`secretary_mail_desk.py catchup` reads content-free `archiveProgress` from
`native-status.json` and `objectiveReviews` from the generated objective
coverage/status receipts. Core preserves these at
`GET /api/secretary/desk` → `data.mail.catchup`. Existing catch-up counters
continue to describe the last general run, not all reviewed archive pages.

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

# Sourced personal timeline contexts

Core stores complete temporal context on the existing owner
`personal_history_entries`, alongside their native source assertions. Documents,
media metadata, ledger extracts, calendar records and direct owner statements
join Gmail and Outlook provenance. No second selected-memory collection or
external agent becomes the authority for these moments.

A source assertion remains a candidate with `assertionState: unknown` on import.
An imported `timeline.reviewState: confirmed`, testimony attribution, photograph
or proposed relation is descriptive source metadata. Only the owner's explicit
native review confirms an assertion. Keeping a souvenir remains a separate
explicit action in the existing owner memory service.

## Import and reconciliation

`POST /api/secretary/history/context/import` accepts `{entries: [...]}`, 1–10
entries. Each item has the following shape (placeholder hashes must be replaced
with SHA-256 of the actual UTF-8 text):

```json
{
  "importId": "example:move-1",
  "expectedContextRevision": 0,
  "entry": {
    "kind": "fact",
    "text": "A move was proposed during this period.",
    "sourceDate": null,
    "source": {
      "system": "document",
      "id": "document-1",
      "sourceSha256": "<native-content-sha256>",
      "findingId": "<stable-finding-sha256>"
    }
  },
  "timeline": {
    "legacyId": "move-1",
    "title": "Proposed move",
    "category": "home",
    "date": "2004",
    "precision": "year",
    "endDate": null,
    "endPrecision": "unknown",
    "ongoing": false,
    "occurrenceStatus": "planned",
    "claimType": "hypothesis",
    "sourceIds": ["document-1"],
    "claimsWithExactQuotes": [
      {"sourceId": "document-1", "quote": "A move was proposed during this period."}
    ]
  },
  "sourceRecords": [{
    "id": "document-1",
    "kind": "document",
    "subject": "Synthetic archive",
    "body": "A move was proposed during this period.",
    "bodySha256": "<exact-body-sha256>",
    "authority": "source-record"
  }],
  "relations": [],
  "media": []
}
```

For enrichment, replace `entry` with the existing native `entryId` and its exact
`sourceKey`; their provenance must match. A stable `importId` belongs to exactly
one native assertion. Native Gmail/Outlook source keys remain unchanged; the
other source keys also include the normalized `source.id`.

All entries and native provenance are validated before the first write. Each
write is atomic for one moment; a batch is not a cross-entry transaction. A
conflict midway can leave earlier moments committed. Reconcile every receipt
before retrying uncertain work.

The history routes use the existing Secretary success envelope. Success returns `data.results[]` with `entryId`, `sourceKey`, `importId`,
`contextRevision`, `contextHash`, `created`, `changed`, `replayed` and the projected
`entry`. The hash covers the normalized imported context, independently of the
request's expected revision and native row ID. An identical retry returns the
same entry/hash without changing either revision, even after owner edits. A
changed import requires the current `expectedContextRevision`. It preserves
owner overrides and native review decisions, revision and souvenir links.

## Temporal and evidence fields

The executable allowlists and limits live in
`core/src/services/personalHistoryContextContract.js`.

- Precisions are `unknown`, `year`, `month`, `day`, `instant`. Partial values
  retain their precision; imported ISO day display anchors can also retain a
  coarser year/month precision. Unknown dates stay empty. Missing source dates
  are explicit `null`, never replaced with an event date or today's date.
- `endDate`, `endPrecision` and `ongoing` describe a period without inventing an
  end. `dateWindow`, `ageStartWindow` and `ageEndWindow` are nullable ordered
  `{start,end}` ISO-day intervals, not exact dates or calculated ages.
- Categories are `home`, `people`, `work`, `travel`, `health`, `daily`.
  Occurrence is `unknown`, `reported`, `planned`, `documented`, `occurred` or
  `cancelled`. The date of a document does not prove its proposed activity took
  place. `hypothesis`, `claimType`, `sourceIndependence`, `confirmationBasis`,
  rationale, questions and contradictions retain their attribution.
- Bounded typed narrative fields (`chapterId`, `title`, `summary`, `pathId`,
  `pathLabel`, `order`, `label`, `context`, `pendingDate`) preserve a proposed
  path through moments. They do not approve the underlying claims.
- Source records retain exact `body` and its required `bodySha256`, including
  PDF page separators. `contentSha256` identifies a native binary separately.
  `nativePath` and relative media asset keys are pointers; this service never
  opens them. Later enrichments retain every previous body under its source ID;
  revised extractions use a new ID while retaining the original record. Media
  bytes remain in the instance's asset store.
- Each quoted claim resolves to a stored source record and matches its body.
  The explicit `match: whitespace` mode permits whitespace folding while
  retaining both original quote and body. It never changes words. A relation
  `agreement` needs quoted records with at least two different source bodies;
  this alone does not establish independent authorship.
- Relations use `agreement`, `sequence`, `conflict` or `hypothesis` with legacy
  event IDs and quoted evidence. `contextLegacyEventRefs` and
  `unresolvedLegacyEventIds` preserve earlier disputed context without creating
  new accepted assertions. Media associations remain proposed.
- `metadata`, native references, event-time annotations and `provenance` accept
  bounded descriptive JSON (64 KiB each, depth 8), with unsafe Mongo/prototype
  keys rejected. They select no executable action, policy, model or memory scope.

Limits: 100 sources, 100 quoted claims per claim list, 100 relations and 100
media bindings per moment; each exact source body is at most 1 MiB and a full
stored context at most 3 MiB. Core's HTTP JSON limit still applies to the whole
batch. Small batches are appropriate when bodies are large.

## Reads and owner edits

`GET /api/secretary/history` retains pagination (`limit` at most 100, `offset`,
`nextOffset`) and exact `sourceKey` / `importId` filters. Each row exposes
`sourceKey`, `importId`, `contextRevision`, `contextHash`, effective `timeline`
and `context` metadata, excluding source bodies. `context.importedTimeline`
retains the imported claims before owner overrides.

`GET /api/secretary/history/:id` returns `{authority: 'agentx.core', entry}`.
`?includeSourceBodies=true` adds stored exact source bodies after integrity
verification. `GET /api/secretary/history/:id/sources/:sourceId` returns
`{authority: 'agentx.core', source}`, including its exact body and SHA-256.
Forgotten or missing records return 404; corrupt stored bodies return an
integrity error rather than silently presenting different evidence.

`POST /api/secretary/history/:id/context` accepts:

```json
{
  "revision": 1,
  "changes": {"timeline": {
    "title": "Owner corrected title",
    "date": "2004-06-12",
    "precision": "day",
    "ageStartWindow": null,
    "dateWindow": null,
    "endDate": null,
    "endPrecision": "unknown",
    "notes": "Explicit owner correction"
  }}
}
```

This existing private owner surface may edit text, dates/precision, period,
category/place, notes/rationale, uncertainty windows, hypothesis, review
questions, safe HTTP links and native `relatedEventIds`. Every related ID must
exist in the same owner scope. Editing a calendar date explicitly clears its
old age/date windows. Source records, source IDs, quoted claims and review
decisions are immutable through this editor.

Owner changes are retained as context overrides with a bounded edit audit and
increment `contextRevision`, separately from the native review `revision`.
Unchanged patches at the current revision are no-ops; stale patches return 409.
Import receipts keep their original hash; source enrichments preserve owner
corrections. Editing creates no souvenir and confirms no assertion.

Explicit confirmation continues through
`POST /api/secretary/history/:id/review`, with native `revision`,
`state: retained`, `assertionState: confirmed` and an explicit owner `reason`.
A contextualized assertion also requires the displayed `contextRevision`; the
write fences both revisions. The confirmation receipt retains that context
revision and hash. A later owner correction or changed source import preserves
the receipt but projects `assertionState: unknown`,
`recordedAssertionState: confirmed` and `confirmationCurrent: false`, until the
owner explicitly reviews the new context. An identical import leaves the
confirmation current.
Retaining alone is not confirmation. The souvenir route remains independent;
it also requires `contextRevision` for a contextualized assertion. It keeps the
effective owner title/description/date, with optional explicit date/text
overrides. Year/month display anchors become partial year/month values in the
souvenir. The note's typed `historyContext` snapshot retains the original
period, age windows, quoted claims, source hashes and targeted context revision.
The keep prepares a hidden pending note, links it with both revision fences,
then activates it. Success also returns `souvenir`, including its typed
`historyContext`; history pages include that snapshot under `entry.souvenir`. Interrupted work resumes the same source identity; a stale
context never publishes an active note. Up to 125 source references retain the
existing native citations plus the context's bounded source records.

Forgetting removes the context, source bodies, media bindings, owner corrections
and review text. The opaque hashed import fence survives alongside the existing native
suppression identity to prevent resurrection. Forgetting a source note also suppresses its linked contexts.
Neither these endpoints nor the context editor are added to Nestor consumer
or family tool permissions.

## Deployment

Deploy Core through the instance's existing procedure. The added unique sparse
`contextImportKey` index belongs to `personal_history_entries`; the import
service verifies that index before its first write. No bulk rewrite or
selected-memory migration is required. Reconcile existing assertions by their
native IDs/source keys before enriching, and verify matching hashes on a lost
response. Check the deployed instance's model pin drift after adding routes,
without starting inference. Private manifests, bodies, media and receipts stay
outside public Git.

## Native Atlas presentation

`/atlas/` reads the native timeline, Secretary desk coverage, and photo APIs. It
keeps no second store of assertions, media associations, or review decisions.
Generic decade chapters and native document readers remain available.

Chapters and the default timeline share the life-moment scope; the all-records
view retains the other archive observations. Opening counts follow the selected
scope and active search constraints. The early “Explorer ma vie” command enters
the existing immersive view explicitly; the page never enters that mode on load.
Calendar scale changes retain the selected day's anchor until navigation moves
outside its window. Photo dossiers show their image before review controls,
with internal import diagnostics folded separately from source evidence.

When Core returns `truncated: true`, Atlas preserves that flag after decisions,
shows a visible partial-coverage notice and qualifies available counts as lower
bounds. These are loaded observations, not an exhaustive history. The backend
limit remains unchanged; this presentation warning does not add pagination.

The factual confirmation button sends `state: retained`,
`assertionState: confirmed`, the displayed entry `revision`, and (for a
contextual entry) `contextRevision` to the existing review route. A conflict is
shown without retrying or replacing the displayed revision. Retention, source
testimony, a kept souvenir, and matching photographs do not confirm a fact.
Owner statements remain labelled “Déclaré par toi”; date uncertainty stays
visible separately. Keeping a souvenir uses its own explicit action. A kept
temporal snapshot retains partial dates and age windows. A souvenir corrected
independently from its source context cannot confirm that different context.

Photos already indexed by Core can be browsed through `/api/photos/search` and
`/api/photos/count`, with native pagination, metadata filters and thumbnails.
A context media record with `provenance.system: agentx.photos` and
`provenance.assetId` uses `/api/photos/assets/:id/thumbnail`. Only explicit
`candidateEventIds` create proposed links in the view, resolving Core IDs and
legacy aliases. Merely storing media on an entry never links it to that entry.
Searching the library creates no binding or face inference.

Source panels preserve `provenance.bodyScope`. Selected table cells, an exact
reviewed passage, and an equivalent copy not read by the model have distinct
French labels. They are never presented as a full PDF or as independent witness
accounts. Coverage selects the latest active `life-timeline` objective version;
full source readings, covered copies, and the general archive review are shown
separately.

### Optional private presentation subjects

The owner-only timeline response may include bounded `displayPreferences` from
`ATLAS_DISPLAY_PREFERENCES_PATH`. It reads at most 32 KiB and exposes only
`storyThreads` (up to 12 subjects, bounded labels, hints, event IDs and search
terms). Unknown fields, statement text and receipt metadata are not returned.
Missing, malformed or oversized files yield no personal subjects; generic
chapters still work. This configuration cannot create or confirm a moment.

With the standard Compose file, set `ATLAS_DISPLAY_PREFERENCES_DIR` to a private
host directory mounted read-only at `/mnt/owner/atlas-display`, then set
`ATLAS_DISPLAY_PREFERENCES_PATH=/mnt/owner/atlas-display/life-atlas-display.json`.
Keep the file and host-specific values out of public Git. Example shape:

```json
{"storyThreads":[{"id":"chosen-subject","label":"My chosen subject","eventIds":["legacy-event-id"],"queries":[["first term","second term"]]}]}
```

Run the focused projection/transport/preferences tests with
`node --test core/surfaces/household/test/atlas*.test.js`. The isolated browser
journey is `node core/tests/browser/atlasParityJourney.cjs`; it uses synthetic
HTTP fixtures and an installed Chromium (`CHROMIUM_PATH` if needed). Optional
`ATLAS_BROWSER_ARTIFACTS` chooses the screenshot/report directory. It never
proxies a real household, loads a model, or writes a real souvenir.

# Living sources

Core exposes one audience-bound directory and read contract over existing
producer records. This is not another memory database, copied corpus or agent
summary store. The Secretary owns mail digests and actions, finance owns its
ledger and alerts, and Data owns weather retrieval. Reading a source does not
launch its producer, change its schedule, send mail or import a statement.

## Sources and authority

| Source | Personal | Family | Native authority and coverage |
|---|---|---|---|
| weather | yes | yes | Default: existing Data/ambient current conditions, without coordinates. Owner-only explicit sections: forecasts, hourly and warnings from the same Data producer. |
| agentx | yes | yes | Core, Benchmark and RAG API reachability through the reports client. Not private operational reports, tasks, logs, inventories or functional acceptance. |
| secretary | yes | no | Core mail journal and email actions through team_brief. Not the complete live mailbox. |
| comptable | yes | no | Core finance balances, months, alerts and statement review through team_brief. |

These are named source contracts, not permission to traverse every API of a
service. The shared AgentX source is deliberately service reachability, not all
AgentX data. A new source needs a reviewed producer contract and audience
binding. Source text, links, persona names and request arguments cannot grant
access to another source or tool. Existing memory scope/sensitivity, secrets and
child boundaries are unchanged. No source is written into selected memory.

The server binds owner or household before discovery and reading. Family cannot
discover or request the private sources, including by calling a handler directly.
The private consumer routes remain outside family-device access. Family runtime
tools never forward to the owner consumer endpoint or consult_team.

## Reads and context

The owner MCP transport exposes source_catalogue and source_read. The equivalent
owner consumer routes are GET /api/consumers/nestor/v1/sources and POST
/api/consumers/nestor/v1/sources/read. OpenClaw uses optional tools in
its existing adapter. Personal sessions use the owner consumer; direct native
sessions of the family agent (including Reader) use GET /api/family/sources and
POST /api/family/sources/read. These routes bind household on the server and
reuse the family source registry, exposing only weather and AgentX reachability.
The adapter derives this choice from the host agent/session context, never tool
arguments, and verifies the audience in every Core receipt. Other owner tools
remain owner-only. Family AgentX inference can use the same tool
names when the instance includes them in HOUSEHOLD_FAMILY_TOOLS. Enabling a
family tool does not expose the owner bus.

Principal personal and family turns receive the same source directory mechanism
and dated weather context. Reader, specialist and LLMx turns do not receive that
context automatically. Reader can explicitly call the family agent's shared
source tools when installed; it receives no owner tools or private sources.
The directory contains metadata, not private records or proof of a
completed read. Tool-free guardians use supplied evidence and leave new work
to the principal; they do not start a duplicate consultation. A runtime without
an installed source tool must not claim it used one.

Small reads return the complete structured data. Larger JSON returns text pages,
contentHash, totalChars and nextOffset; a complete JSON parses only once all its
pages are concatenated, but a bounded answer may stop paging early when the
incomplete coverage is disclosed. Continue using nextReadArgs plus
offset=nextOffset and expectedHash=contentHash. SOURCE_CHANGED means restart
from offset zero. The hash binds content, source and audience. There is no saved snapshot: a native
change can invalidate a continuation. Unicode pairs are not split.

Record pagination is independent of JSON transport pagination: recordOffset
carries the record cursor, while the transport page position is the separate
offset argument. Within a brief, section.pagination declares limit, offset,
returned, hasMore and nextOffset. Read one section and pass
recordOffset=section.pagination.nextOffset to source_read (offset to
team_brief). Retain asOf from the first brief to keep
the same date window. Record order is deterministic, but consistency is live:
concurrent record insertion/deletion can move offsets. Pagination does not
claim a frozen database snapshot. All limits are per-page, not an assertion
that the source has no further records.

Brief windows are explicit (days/since/asOf). They are a query view, not an
editorial decision to erase older source content; change the window or use the
native domain readers to go further. Monetary Display fields are produced by
Core and must be relayed without model arithmetic.

## Freshness and failure

readAt and lastSuccessfulReadAt describe this read only, not the last successful
producer run. No cross-request success history is invented. sourceUpdatedAt is a
source-specific timestamp the source itself exposes for this read (for weather,
the retrieval timestamp), not a generic newest-content time and not proof of
completeness; it is null when the producer exposes no reliable timestamp. Brief
metadata marks that unknown and preserves domain dates and coverage within
sections.
A fixed asOf anchors the query window; it is not a producer observation time.

producerEvidence distinguishes native retrieval evidence from producer runs.
Unknown run history, last failures and effective cadence remain null with
explicit missing evidence. It is a read-only projection, not a receipt store.
A successful scheduler job does not establish complete source coverage.

Secretary recordUpdatedAt/recordCreatedAt describe only records already returned
on the current page and window, without extra queries. They do not establish the
latest mailbox receipt or complete journal freshness. Finance's freshness section
reads the existing personal-ledger finance_ingestions receipt.appliedAt with a
one-second database execution limit; timeout or an unavailable journal remains
explicit. lastAttestedImportAt covers journaled imports, not legacy imports,
repairs or the transaction date. Rejected imports have no reliable terminal
timestamp, so lastFailedAt stays unknown. This runs only on an explicit source
or brief freshness read, never directory injection.

Weather retains fetchedAt as retrieval time, not observation time. Native
current.observedAt is preserved by the ambient projection; source reads normalize
parseable observation dates and leave missing, invalid or more than one minute
future dates null. The same future-date validation applies to import receipts.
observationAgeMs and an explicit warning separate retrieval availability from
observation freshness. No observation-age threshold or producer cadence is
inferred; observationFreshness remains unknown. Automatic personal and family
principal context uses this same weather projection, includes the observation
age and warning, and never promotes a recently retrieved old or undated
observation to a current observation.
lastSuccessfulRetrievalAt comes from Data, never this read. Retrieval is on
demand; cache lifetime is not periodic cadence. Data does not expose historical
failures through this contract, so none are inferred. Conditions
older than 30 minutes are stale, missing/invalid or materially future timestamps
are unavailable. AgentX checks are request-time probes, not whole-machine health.
A partial or failed section remains explicit; raw exception messages are not
returned. An empty page is not proof the whole producer is empty.

Refresh means reread the native source under its existing cache contract. It does
not bypass that cache or run an ingestion job. Source-specific deeper work stays
with existing tools: consult_team for the Secretary/Accountant, with unchanged
authorization, admission and uncertain-result handling. The directory does not
grant a family caller access to those collaborators.

## Deployment and qualification

Source unit tests, producer pagination tests, family context/tool tests and
OpenClaw adapter tests cover the contract. Code and test results do not establish
installation or live model behavior. Deployment must separately install the
reviewed Core/adapter revisions and, if requested, enable the family tools and
native tool allowlists. Existing producer schedules are preserved. No new
background reconciliation or producer event subscription is installed here.

Qualify native discovery and actual reads in each intended runtime, stale and
failed sources, complete multi-page reads, private-source refusal in family,
and conversation/guardian continuity. Queue model-based acceptance through the
existing heavy-work entrance. Keep private receipts outside public Git.

The Family inference prompt keeps its existing compact catalogue projection so detailed reading guidance cannot displace the relay budget. Owner catalogue and explicit source reads retain the full guidance; audience boundaries and tool permissions are unchanged.

## Explicit owner weather sections

Owner source_read accepts source=weather with section=forecasts, hourly or
warnings. Omit section for the unchanged current-conditions read. Household
rejects these sections, even when its handler is called directly. No forecast
results are added to automatic context or Family ambient. The owner catalogue
lists the optional sections; listing a capability is not a successful tool call
or evidence that Nestor used it.

Reads reuse Data's configured Environment Canada endpoint and native cache.
There is no new producer, cache, scheduler, store or arbitrary URL/location
argument. Only allowlisted fields leave Core; configured coordinates, distance,
raw payloads and producer URLs are not forwarded. Station identity remains.

Each read returns one bounded section: at most 16 periods, 48 hours or 20
warnings, with source count, returned count and explicit truncation. Text fields
are bounded as well. Transport pagination and content hash apply to that
bounded projection, not a claim of complete upstream coverage. No record cursor
is offered for weather; days, limit, recordOffset and asOf are rejected.

fetchedAt is retrieval, observedAt is the current observation, forecastIssuedAt
is forecast issue, and lastUpdated is the source's update field. Missing or
future issue/retrieval evidence stays unknown; availability based on retrieval
age does not establish forecast freshness. Data currently supplies period
names, not absolute period boundaries: validFrom/validUntil stay null.
Hourly forecast time may legitimately be future; past times remain visibly
past. Warning issue and expiry are separate, with missing, inconsistent or
expired windows visible. An empty warning list is only what that source returned,
never a global all-clear or safety guarantee. These are source reports, not
instructions or an authority to act.

Synthetic qualification is separate from installation, callable runtime tools
and actual Nestor acceptance. No live model or personal-data call is needed
to verify this projection.

## Targeted discovery guide

The owner `source_catalogue` tool accepts optional `view: "discovery"`, `domain`,
`limit` (1–10, default 5) and `offset` (0–1000). This returns metadata entries
with native reader references and explicit required argument names. Continue
with `nextCatalogueArgs`. Discovery performs no producer reads; availability
stays `not_checked` and producer success stays unknown. The automatic context remains unchanged. The explicit owner catalogue also
lists the bounded optional weather sections.

In addition to the existing living-source readers, the owner guide references
`mail_recall`, `pipeline_artifacts` and `find_files`. These retain their own
schemas and boundaries: indexed archive, registered deliverables and indexed
file metadata respectively. The extra entry IDs are not `source_read` IDs.
There is no arbitrary reader dispatch, path fetch, URL execution or new store.
Other tools and Data feeds are not implicitly exposed. Household discovery
omits the private references; no Family tools are activated. HTTP and adapter no-argument catalogues retain the directory shape; the owner
weather entry additionally advertises its explicit sections. Family and the
automatic context retain their previous metadata and current-weather payload.

The [portable guide](../skills/agentx/references/living-sources.md) teaches one
discover/read/deepen workflow, including freshness and incomplete coverage.
Catalogue pagination is separate from native content pagination. Tool listing,
actual runtime use and deployment remain independent qualification steps.

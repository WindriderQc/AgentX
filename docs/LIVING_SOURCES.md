# Living sources

Core exposes one audience-bound directory and read contract over existing
producer records. This is not another memory database, copied corpus or agent
summary store. The Secretary owns mail digests and actions, finance owns its
ledger and alerts, and Data owns weather retrieval. Reading a source does not
launch its producer, change its schedule, send mail or import a statement.

## Sources and authority

| Source | Personal | Family | Native authority and coverage |
|---|---|---|---|
| weather | yes | yes | The existing Data/ambient current-conditions contract, without coordinates. Not forecasts. |
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
contentHash, totalChars and nextOffset; concatenate all text pages before parsing.
Continue using nextReadArgs plus offset=nextOffset and
expectedHash=contentHash. SOURCE_CHANGED means restart from offset zero. The
hash binds content, source and audience. There is no saved snapshot: a native
change can invalidate a continuation. Unicode pairs are not split.

Record pagination is independent of JSON transport pagination. Within a brief,
section.pagination declares limit, offset, returned, hasMore and nextOffset.
Read one section and pass recordOffset=section.pagination.nextOffset to
source_read (offset to team_brief). Retain asOf from the first brief to keep
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
producer run. No cross-request success history is invented. sourceUpdatedAt
is null when the producer does not expose a reliable timestamp. Brief metadata
marks that unknown and preserves domain dates and coverage within sections.
A fixed asOf anchors the query window; it is not a producer observation time.

Weather retains fetchedAt as retrieval time, not observation time. Conditions
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

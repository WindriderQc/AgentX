# Living Sources and persona artifacts

Use a Living Source for producer-maintained records. Discover with
`source_catalogue`, then call `source_read` with the returned source ID
and the smallest relevant section or window. A directory entry attests
what the producer can expose. The read returns the available evidence.

## Choose the scoped reader

| Scope | Runtime tools or Core fallback | Available sources |
|---|---|---|
| Owner | Discover the tools on the owner MCP bus. `GET /api/consumers/nestor/v1/sources` and `POST /api/consumers/nestor/v1/sources/read` are the corresponding reads. | `weather`, `agentx`, `secretary`, `comptable` |
| Famille and its Reader | Use `source_catalogue`/`source_read` if the family runtime exposes them, or `GET /api/family/sources` and `POST /api/family/sources/read` in the same scope. | `weather`, `agentx` |

Send the same read arguments in the POST body. The server binds the audience.
The family transport rejects private sources before reading them, typically
with `INVALID_ARGUMENTS`. Preserve the returned error and the same audience
across fallbacks. Native OpenClaw and family tools require
installation or allowlisting. A tool-free persona can use evidence supplied
to its turn. It cannot claim a source read.

## Read the producer's artifact

| Source | What to open | Evidence to return |
|---|---|---|
| `secretary` | `source_read {source: "secretary", section: "mail"}` for dated digests, or section `flaggedForOwner` for the Secretary's recorded actions. | Producer, query dates, relevant digest or action and exact message/thread reference if returned. Follow `mail_recall` or the authorized original for exact provenance. |
| `comptable` | `source_read {source: "comptable", section: "freshness"}`, then `balances`, `recentMonths`, `pendingAlerts` or `statementsToReview` as needed. | Ledger dates, import evidence and each balance's date. Relay Core's monetary Display values verbatim. |
| `weather` | `source_read {source: "weather"}` for current conditions, section `forecast` for periods and dated hours, or `alerts` for warnings in the configured household area. | Use `observedAt` for observations, `forecastIssuedAt` and the issue date for bulletin periods, and issue/expiry times for alerts. Check section status and coverage. `fetchedAt` dates retrieval. An explicit current read can refresh missing or stale conditions. |
| `agentx` | `source_read {source: "agentx"}` for Core, Benchmark and RAG reachability. | Per-service reachability and `readAt`. For an owner diagnostic of jobs, hosts or dependencies, follow [Ops](ops.md#service-directory). |

Reads neither launch collaborators nor run ingestion. For the authorized
owner, `team_brief` is a fallback for those same Secretary/Accountant
records. Use the [native team path](assistant.md#team-secretary-and-accountant)
for exact live mail or specialist work beyond the records. Use
[Pipeline deliverables](dev.md#pipeline-tasks) for a worker's report. For
a persona artifact outside the catalogue, use the owning tool or page if
available and allowed. An arbitrary artifact URL has no Living Source reader.

## Verify the read

- Check `source`, `audience`, producer, `status`, `producerEvidence`,
  and per-section coverage. `readAt` dates the read. `sourceUpdatedAt` is
  source-specific and can be null. For mail, record timestamps apply to the
  returned page. For finance, `lastAttestedImportAt` covers journaled imports.
- Large results return JSON text pages. Continue with `nextReadArgs`,
  `offset=nextOffset` and `expectedHash=contentHash`. Join the text
  before parsing and restart at zero on `SOURCE_CHANGED`.
- For another **record** page in a brief, pass
  `recordOffset=section.pagination.nextOffset` with the same `asOf`,
  section and days. Start that transport read at offset zero. Record paging
  is live. An empty page, missing producer date or unavailable section limits
  what you can conclude. Rereading follows the existing cache.

Product contract: `docs/LIVING_SOURCES.md`, `core/src/services/livingSourceService.js`
and `core/src/services/teamBriefService.js` at the running Core revision.

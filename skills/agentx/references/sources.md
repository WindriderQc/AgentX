# Living Sources and persona records

Read the artifact its producer already maintains. In a personal session,
discover owner `source_catalogue` and `source_read`. In Famille, use only the
installed family tools of those names, bound by the server to `household`.
The catalogue supplies producer, coverage and read contract. Read a source to
obtain any record. A persona name by itself identifies no collection of files.

| Source | Audience | Example of a bounded read |
|---|---|---|
| `secretary` | Owner | `{"source":"secretary","section":"mail","days":7,"limit":5}` reads processed journal digests. `flaggedForOwner` reads flagged actions. For a digest, identify the returned entry and its own date. |
| `comptable` | Owner | `{"source":"comptable","section":"balances"}` reads dated ledger balances. Read `freshness` for transaction dates and attested imports. Relay monetary Display fields exactly. |
| `weather` | Owner, household | Current configured station conditions. Distinguish `fetchedAt` from the observation time and age. A new retrieval can return an old observation. |
| `agentx` | Owner, household | Core, Benchmark and RAG API reachability at read time. Private operational reports use their own reader. |

1. Check the receipt's `audience`, `source`, `producer`, `status` and requested
   window. Read `data.sections` for personal briefs. Cite the entry, section
   and its date, coverage and any unavailable fields. `readAt` and
   `lastSuccessfulReadAt` date this read. `sourceUpdatedAt` can be null.
   `producerEvidence` qualifies the observed retrieval or import. No timestamp
   implies a producer schedule. An empty mail page covers only its query.
2. Large JSON arrives as text. Continue with `nextReadArgs`,
   `offset=nextOffset` and `expectedHash=contentHash` until `nextOffset` is
   null, then concatenate and parse the text. Restart at zero on
   `SOURCE_CHANGED`. For more **records** in one section pass
   `recordOffset=section.pagination.nextOffset` and keep the initial `asOf`.
   Disclose a partial page or window if it suffices. Record order can move.
3. If the tool is absent, equivalent same-audience contracts are owner
   `GET /api/consumers/nestor/v1/sources` and
   `POST /api/consumers/nestor/v1/sources/read`, or household
   `GET /api/family/sources` and `POST /api/family/sources/read`.
   The POST is a read. Stop on refusal. A missing family source stays private;
   never ask an owner proxy or consult a persona to obtain it for Famille.
4. For an owner request beyond the stored record, the catalogue may name a
   deeper native collaborator. [Team consultations](assistant.md#team-secretary-and-accountant)
   have their own authority and completion receipts. Reading never launches
   the persona or imports new data. For a coding worker's registered file
   use [Pipeline deliverables](dev.md#pipeline-tasks), a different producer.

Product contract: `docs/LIVING_SOURCES.md` at the revision in `served.md`.

# Current selected Core record restoration

`POST /api/secretary/history/core-restoration` qualifies a bounded temporary
restore of the current selected owner history records and their directly linked
active souvenirs. It returns `agentx.history-core-restoration/v1` on the existing
private owner Secretary surface, with `Cache-Control: private, no-store`.

Input contains 1–20 exact Gmail `sources`, a fresh `observationId` UUID and optional
`expected`/`expectedBindingsSha256` fingerprints. The existing global source
validator sorts and bounds the selection. No supplied document, proof, database,
collection, host, path, restore target or permission can widen it. An earlier
binding mismatch refuses before temporary copying. Family audiences and pinned
family devices retain their existing denial.

Core's internal full-document reader reuses the existing owner selection,
privacy checks and active-memory policy. Its raw native BSON frames retain
context bodies, unknown stored fields and embedding arrays, including their BSON
numeric/binary/date types. Each nested raw document must serialize back exactly;
unsupported/deprecated representations refuse rather than silently normalize.
Metadata-only readers retain their original body/vector exclusions and wire
contracts. Full-document and alternate-store options are internal server ports,
not HTTP or model-tool inputs.

The selection is limited to 100 unique current history records and 100 linked
active souvenirs, 512 KiB per full document, 8 MiB per joined source group and
16 MiB combined unique copied documents. Repeated joined note copies consume
the source read budget. Each collection has at most 64 supported native Mongo
index definitions. Source collections must be ordinary product model collections
without additional Mongo collection options; unknown options or unsupported,
unfinished or TTL indexes refuse. No canonical collection is created or changed
by the restoration mechanism; existing privacy erasure checks retain authority.

The Core engine serializes its trusted input synchronously, then creates private
unpredictable temporary namespaces in the existing database. A private,
tautological validator distinguishes native creation from Mongo's idempotent
same-options create behavior; it imposes no restriction on copied documents.
The engine captures each collection UUID and validator ownership marker.

Guard capability and existing privileges are qualified on an empty private probe
before document copies. Every removal uses Mongo's native expected-UUID drop;
there is no plain-drop or drop-database fallback. A lost acknowledgement is read
back by original UUID without a second drop. Replaced, renamed or tainted
custody fails closed; unknown custody is retained and safe owned peers are
removed where qualified. The trusted DB account is the boundary; adversarial
same-account isolation is not established. No privilege or instance change is
requested to bypass an unavailable guard.

Documents and supported indexes are recreated and natively reread from raw BSON.
Source and restored index definitions must serialize back exactly too; numeric
field names whose native order JavaScript cannot represent refuse. Compound
index key order is preserved. Both full-document and logical index-definition
hashes must match. The existing Core queries, owner filters, projections and
decision hashes then run against the restored collections through internal
read ports. The resulting bindings must equal the source binding fingerprint.
Owned data/indexes are checked again before guarded removal; success requires
all original temporary copies to be gone.

After restoration and removal, Core rereads source catalog/index definitions
and the entire full-document selection. Its final joined data query follows
privacy awaits; no asynchronous evidence read follows it. Late body/vector
edits, new members or erasure refuse even if declared metadata revisions did
not change. No private document, embedding, temporary name, UUID or DB address
leaves the reader; responses contain selected references, hashes and counts.

`retention_reconcile.py --native-core-restoration` selects private report v12 and
implies the existing global downstream/finding/message/decision observations.
It composes v5–v11. The client derives the exact bindings from already verified
v10 snapshots and requires two matching native restore observations, each bounded
to 2 MiB and 240 seconds without retry. These are the last HTTP calls, after any
v11 manifest. Only local disposition checks and any applicable v9/v11 local graph
binding follow. Failed evidence writes no success report; stdout contains counts
only. V12 exits 2 because global native acceptance gaps remain; older modes keep
their meanings.

This proves selected current document/index and business-query roundtrips, not
physical storage independence, whole-Core disaster recovery, erased/tombstone or
vault restoration, recall/Qdrant qualification, semantic acceptance, authenticated
consent or mailbox approval. Collection validators/options are not restored.
All four global native gaps, false execution and blocked cleanup remain. No
canonical restore executor, model call or deployment follows from this code.
Real storage qualification retains its own authorization and Core queue; isolated
CPU/Mongo fixtures do not qualify an installed database or corpus.

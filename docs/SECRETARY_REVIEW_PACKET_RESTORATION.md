# Current selected review-file graph restoration

The existing owner preservation API accepts the explicit verification mode
`review-restoration`. It retains `agentx.history-preservation/v3` on the same
assertion, with the existing request UUID, revision/source binding and erasure
fences. Earlier preservation/restoration modes and receipts retain their original
meaning; a request identity cannot switch modes or upgrade a retained proof.
The native command is `review-restoration` through the existing primary/mirror
Secretary transport. It reads archives without Gmail authorization or fallback.

The native reader first verifies the exact original, recorded attachments and
MIME through the existing preservation reader. It then opens the selected
current review graph through the same no-follow, bounded source descriptors:

- The raw receipt/original, manifest, thread `original.json`, current `packet.txt`
  and thread review. The packet bytes must match the manifest evidence hash and
  selected parsed body must match its recorded body hash.
- `value-lanes.json`, with the selected message's exact thread and known lane.
- Download receipts for the selected original attachment parts, bound to those
  parts' metadata and current attachment hashes/lengths/paths.
- Declared native/OCR text artifacts, and the OCR receipt when the manifest uses
  an OCR reading. No extraction, OCR or model is launched.
- Current cached compound indexes and their preserved member blobs, validated by
  source/member identities and hashes. An incomplete or missing compound index
  refuses; no decompression or member execution occurs.
- Every page generated for this selected message by the existing page producer,
  with its current page-review receipt. Other messages' attachment files are
  not opened to generate the selected pages; shared thread metadata files are
  preserved whole. Page IDs, attribution and default reader behavior stay intact.

Required missing/stale files, inconsistent identities, links or bounds refuse.
There is no originals-only fallback. The graph includes the complete current
shared metadata files; unrelated changes within those files can stale a receipt.
The scope excludes historical superseded files, unreferenced archive files,
separately fetched reference snapshots under `reads/`,
Core commitments/decisions and recall indexes, the instance's private human
review grid, model qualification and semantic acceptance of any recorded reading.
A preserved artifact is not a proof that its interpretation is correct.

The existing native private-custody mechanism copies the qualified graph to
private temporary disk, reopens it through the same graph and MIME checks,
compares source/restored file sets and bytes, then removes only its own verified
temporary entries before success. Late source-byte changes fail the existing
current-byte fences. Unknown/replaced custody entries retain the existing closed
error/restitution behavior; archive files are never cleaned. The OS account is
trusted; same-UID adversarial isolation and physical storage failure domains are
not established by this protocol.

Each source graph is bounded to 256 unique files and 16 MiB total, including raw
bytes and metadata, 128 selected pages, 128 compound member occurrences and 512
messages in shared thread metadata. Existing attachment/MIME, path-depth and
custody-directory limits still apply; combinations exceeding any bound refuse.
Only hashes/counts leave the native reader. Both distinct native machines must
agree on the complete graph, in addition to the original/MIME checks.

`POST /api/secretary/history/preservation-scope` with explicit
`verification: review-restoration` rechecks 1–20 retained v3 receipts as
`agentx.history-restoration-scope/v2`, with the existing final global Core fence.
Default input retains the original v1 selected-restoration contract and accepts
only the earlier v2 receipts. Neither mode accepts the other as a fallback.

`--native-review-restoration-checks <private-file>` selects reconciliation v9
and implies the existing v4 checks. The file selects exactly one retained native
v3 entry/request/snapshot/source receipt per saved message. It is mutually
exclusive with the old `--native-restoration-checks` option and composes the
v6–v8 options. No new receipt is created by reconciliation.

The client requires two complete native scope observations, then independently
opens the same bounded local graph and requires exact equality with both native
copies and the already verified finding review/evidence hashes. Final Core and
archive-disposition fences follow all native calls and the local graph check.
HTTP observations retain the 2 MiB/960 second bounds and no automatic retries;
Core snapshots retain the existing 1 MiB bound. Reports remain immutable/private;
stdout contains status/counts only. Failed or changing evidence writes no success
report. Exit zero means matching observations, with all four native global gaps,
`executionAllowed: false` and `cleanupStatus: blocked` still present.

No real-corpus reception, deployment, permission or mailbox effect follows from
isolated tests or installing this optional code. Real restoration retains its
separate authorization and heavy-work queue requirements.

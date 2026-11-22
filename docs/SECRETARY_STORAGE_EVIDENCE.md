# Native selected review-file storage observations

`secretary_mail_desk.py storage-evidence` uses the existing pinned archive root
and exact `--message`, `--thread`, `--sha256`, `--request-id` selection. It needs
no Gmail authorization. It accepts no host, device, topology or identifier
assertions. The native producer returns `secretary.archive-storage-evidence/v1`
with the complete existing review-restoration proof and a `storage` object.

The producer restores the selected current review graph through the existing
private-custody copy/reread/removal mechanism. Its internal post-restoration
callback retains every qualified source descriptor and the archive-root
descriptor. It reads their native Linux `mnt_id` and device numbers, resolves
them against `/proc/self/mountinfo`, and requires ext4 or XFS for every descriptor.
It traverses bounded sysfs partition parents and block-device slaves. Partitions
collapse to whole disks; NVMe namespaces collapse to their PCIe controller's
serial, model and vendor. Local SCSI/ATA devices require a nonzero NAA/EUI WWID;
missing WWIDs never fall back to another identifier family. SCSI/USB bridges
explicitly identifying NVMe remain unqualified. Unknown drivers, virtual/fabric paths, logical RAID
models and missing, contradictory or weak identifiers remain unqualified.

The producer takes two kernel observations inside the same callback, with
existing source-byte/descriptor fences before, between and after them. Any
observation change removes all reported disk IDs. The kernel view and OS
account are trusted; this is no hardware attestation. Metadata is read only,
without commands, device writes or elevated privileges.

`storage.contract` is `secretary.archive-storage-topology/v1`; `scope` is
`selected-current-review-files-kernel-device-identities`. `files` and
`filesSha256` match the restoration's source-file count and complete file-set
hash. `observed_local_devices` contains 1–32 sorted, unique SHA-256 disk IDs
and no blockers. IDs use a fixed identifier namespace with no machine/path
salt, so aliases and matching identifiers across machines compare equally.
`unqualified` contains no disk IDs and at least one generic blocker code.
Raw paths, kernel metadata, models and serials stay inside the reader.

Every result keeps `physicalIndependenceAccepted: false`. These observations
establish neither physical independence nor a cleanup decision. The scope
covers only the selected current review files and archive root; the temporary
restoration destination, unreferenced/historical files, firmware honesty,
hypervisor hardware and enclosure/failure-domain guarantees are outside it.

Each sysfs traversal has at most 128 nodes, depth 16 and 32 slave entries or
physical IDs. Mount metadata has at most 8,192 rows and 4 MiB; individual sysfs
values have at most 512 bytes. Existing review/restoration source, file-count,
byte, MIME and custody bounds still apply. Unsupported or inaccessible native
metadata produces only an unqualified observation; invalid or changing source
bytes still refuse the restoration entirely. Source tests, installation and
real-instance acceptance remain separate evidence.

## Core selected-set observation

`POST /api/secretary/history/storage-scope` takes 1–20 exact `sources`, a fresh
`observationId` and an optional expected fingerprint. The owner human surface
and existing family-pin restrictions apply. Caller input cannot choose a host,
archive root, device, supplied topology or acceptance outcome. The existing
operator-selected primary and mirror transports run the new native command;
an absent or unsupported reader has no fallback.

Core first observes the complete current message membership, then performs two
complete native storage passes over the selected set. Each copy must provide
its valid original/MIME/review-graph/restoration proof, with the topology bound
to that exact restored file count and hash. Both passes must agree. A final
common selected Core/privacy fence follows every native producer; no later
asynchronous evidence read follows it. The response is not an atomic snapshot.

The contract is `agentx.history-storage-scope/v1`. Metadata contains selected
references, Core member pins, native copy proofs and opaque device hashes.
Matching machine identities, shared device hashes, unequal copy content or any
unqualified topology hold the member. `distinct_kernel_devices_observed` names
only the absence of those observed blockers. It is not physical-independence
acceptance. Native failure or incomplete/changing evidence returns no partial
scope. Snapshot metadata is bounded to 1 MiB and uses `private, no-store`.

## Standalone private consumer

`native_history_storage_scope.capture(core, saved, scopes, review_restoration)`
consumes already verified native message-discovery receipts and the nested v9
review-restoration observation. It revalidates exact selected references,
retained check/pin hashes and revisions, then matches each newly observed copy
to its own verified v9 metadata. Two fresh HTTP observations must agree, with
strict schemas, types, nonces, ordered dates and recomputed coverage. Each
response is bounded to 2 MiB with a 1,200-second timeout and no automatic retry.

This is a standalone observation, not a new reconciliation CLI mode. Existing
v1–v14 reports retain their behavior. All four generic native gaps remain in
this storage observation, with `physicalIndependenceAccepted`,
`semanticAcceptance`, `approvalBound` and `executionAllowed` false,
`authenticatedPerson` null, `mailboxEffects` zero and cleanup blocked. It neither
installs a probe nor changes an instance or a mailbox.

Native integration tests use actual source FDs, archive/MIME/review readers,
temporary restoration, HTTP and disposable MongoDB. Their machine and sysfs/
mount metadata are explicitly synthetic; they qualify the code path, not the
installed disks. Namespace identities differ from physical-device identities;
see the [kernel NVMe ABI](https://docs.kernel.org/admin-guide/abi-stable.html).

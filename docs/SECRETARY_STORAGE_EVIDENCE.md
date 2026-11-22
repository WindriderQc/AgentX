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

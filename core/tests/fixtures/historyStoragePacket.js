'use strict';

function storagePacket(input, copy = 'primary') {
  return { contract: 'secretary.archive-storage-evidence/v1', requestId: input.requestId,
    messageId: input.messageId, threadId: input.threadId, sourceSha256: input.sourceSha256,
    machineIdSha256: (copy === 'primary' ? '1' : '2').repeat(64), archiveIdSha256: (copy === 'primary' ? '3' : '4').repeat(64),
    raw: { sha256: input.sourceSha256, bytes: 100 }, attachments: [], metadataSha256: '5'.repeat(64), partsDecoded: 1, attachmentsDecoded: 0,
    reviewPacket: { contract: 'secretary.archive-review-packet/v1', evidenceHash: '6'.repeat(64), reviewSha256: '7'.repeat(64),
      pagesSha256: '8'.repeat(64), valueLanesSha256: '9'.repeat(64), filesSha256: 'a'.repeat(64),
      counts: { files: 7, bytes: 400, pages: 1, attachments: 0, compoundMembers: 0 } },
    restoration: { sourceFilesSha256: 'a'.repeat(64), restoredFilesSha256: 'a'.repeat(64), filesCopied: 7, bytesCopied: 400, temporaryCopyRemoved: true },
    storage: { contract: 'secretary.archive-storage-topology/v1', scope: 'selected-current-review-files-kernel-device-identities',
      status: 'observed_local_devices', files: 7, filesSha256: 'a'.repeat(64),
      physicalDiskIdsSha256: [(copy === 'primary' ? 'b' : 'c').repeat(64)], blockers: [], physicalIndependenceAccepted: false } };
}

module.exports = { storagePacket };

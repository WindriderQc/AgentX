'use strict';

const source = { system: 'gmail', messageId: '1234567890abcdef', threadId: '1234567890abcdea',
  sourceSha256: 'a'.repeat(64), findingId: 'b'.repeat(64) };
const proof = (copy, input) => ({ contract: 'secretary.archive-preservation/v1', requestId: input.requestId,
  messageId: input.messageId, threadId: input.threadId, sourceSha256: input.sourceSha256,
  machineIdSha256: (copy === 'primary' ? 'c' : 'd').repeat(64), archiveIdSha256: 'e'.repeat(64),
  raw: { sha256: input.sourceSha256, bytes: 1000 }, attachments: [{ partId: '1', sha256: 'f'.repeat(64), bytes: 20 }],
  metadataSha256: '1'.repeat(64), partsDecoded: 2, attachmentsDecoded: 1 });

module.exports = { proof, source };

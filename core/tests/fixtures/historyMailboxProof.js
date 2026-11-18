'use strict';
const { source } = require('./historyPreservationProof');
const reference = Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(key => [key, source[key]]));
const proof = input => ({ contract: 'secretary.mailbox-source/v1', requestId: input.requestId,
  messageId: input.messageId, threadId: input.threadId, sourceSha256: input.sourceSha256,
  accountSelectionSha256: 'c'.repeat(64), status: 'present',
  current: { messageId: input.messageId, threadId: input.threadId, internalDate: '1234567890000',
    historyId: '99999999999999999999', labelIds: ['INBOX'], raw: { sha256: input.sourceSha256, bytes: 1000 } },
  scope: 'selected-live-message-raw-and-metadata', mailboxEffects: 0, approvalBound: false });
module.exports = { source, reference, proof };

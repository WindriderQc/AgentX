'use strict';

const { source } = require('./historyPreservationProof');
const proof = (input, extra = {}) => ({ contract: 'secretary.archive-findings/v1', requestId: input.requestId,
  messageId: input.messageId, threadId: input.threadId, sourceSha256: input.sourceSha256,
  evidenceHash: 'c'.repeat(64), reviewSha256: 'd'.repeat(64), metadataSha256: 'e'.repeat(64),
  raw: { sha256: input.sourceSha256, bytes: 1000 },
  findings: [{ findingId: source.findingId, section: 'memories' }, { findingId: 'f'.repeat(64), section: 'actions' }],
  threadQuestions: [{ questionId: '9'.repeat(64) }], scope: 'recorded-selected-message-findings-and-thread-questions',
  semanticAcceptance: false, executionAllowed: false, ...extra });

module.exports = { source, proof };

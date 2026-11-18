'use strict';
const { randomUUID } = require('node:crypto');
const contract = require('../../src/services/personalHistoryReviewRestorationContract');
const { proof, source } = require('../fixtures/historyPreservationProof');
const native = input => ({ ...proof('primary', input), contract: contract.CONTRACT,
  restoration: { sourceFilesSha256: '5'.repeat(64), restoredFilesSha256: '5'.repeat(64), filesCopied: 8, bytesCopied: 2000, temporaryCopyRemoved: true },
  reviewPacket: { contract: 'secretary.archive-review-packet/v1', evidenceHash: '1'.repeat(64), reviewSha256: '2'.repeat(64),
    pagesSha256: '3'.repeat(64), valueLanesSha256: '4'.repeat(64), filesSha256: '5'.repeat(64),
    counts: { files: 8, bytes: 2000, pages: 1, attachments: 1, compoundMembers: 0 } } });

test('strict review proof remains source/nonce/restoration bound', () => {
  const input = { requestId: randomUUID(), ...source };
  expect(contract.describe(native(input), input.requestId, source).reviewPacket.counts.files).toBe(8);
  const changes = [v => { v.requestId = randomUUID(); }, v => { v.sourceSha256 = '9'.repeat(64); },
    v => { v.contract = 'secretary.archive-restoration/v1'; }, v => { delete v.reviewPacket; },
    v => { v.reviewPacket.counts.files = true; }, v => { v.reviewPacket.counts.files = 257; },
    v => { v.reviewPacket.counts.pages = 0; }, v => { v.reviewPacket.counts.compoundMembers = 129; },
    v => { v.reviewPacket.counts.attachments = 2; }, v => { v.reviewPacket.counts.bytes = 2001; },
    v => { v.reviewPacket.filesSha256 = '9'.repeat(64); }, v => { v.reviewPacket.filesSha256 = ['5'.repeat(64)]; },
    v => { v.reviewPacket.accepted = true; }, v => { v.reviewPacket.counts.privateText = 'Synthetic private'; },
    v => { v.restoration.temporaryCopyRemoved = false; }, v => { v.restoration.filesCopied = false; },
    v => { v.restoration.bytesCopied = 16 * 1024 * 1024 + 1; }];
  for (const change of changes) { const value = native(input); change(value); expect(() => contract.describe(value, input.requestId, source)).toThrow(); }
});

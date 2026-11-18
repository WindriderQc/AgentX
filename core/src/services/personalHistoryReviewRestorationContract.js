'use strict';

const preservation = require('./personalHistoryPreservationContract');
const restoration = require('./personalHistoryRestorationContract');
const { digest } = require('./personalHistorySourceReviewSources');
const CONTRACT = 'secretary.archive-review-restoration/v1';
const SCOPE = 'selected-original-attachments-mime-review-packet-and-temporary-disk-restore';
const HASH = /^[a-f0-9]{64}$/;
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function describe(value, nonce, reference) {
  if (!value || value.contract !== CONTRACT) throw new Error('Invalid native review restoration');
  const { reviewPacket, ...source } = value;
  const proof = restoration.describe({ ...source, contract: restoration.CONTRACT }, nonce, reference, { maximumFiles: 256 });
  if (!keys(reviewPacket, ['contract', 'evidenceHash', 'reviewSha256', 'pagesSha256', 'valueLanesSha256', 'filesSha256', 'counts'])
    || reviewPacket.contract !== 'secretary.archive-review-packet/v1'
    || ['evidenceHash', 'reviewSha256', 'pagesSha256', 'valueLanesSha256', 'filesSha256'].some(key => typeof reviewPacket[key] !== 'string' || !HASH.test(reviewPacket[key]))
    || !keys(reviewPacket.counts, ['files', 'bytes', 'pages', 'attachments', 'compoundMembers'])
    || Object.values(reviewPacket.counts).some(count => !Number.isSafeInteger(count) || count < 0)
    || reviewPacket.counts.files < 7 || reviewPacket.counts.files > 256
    || reviewPacket.counts.pages < 1 || reviewPacket.counts.pages > 128 || reviewPacket.counts.compoundMembers > 128
    || reviewPacket.counts.attachments !== proof.packet.attachments.length
    || reviewPacket.counts.files !== proof.restoration.filesCopied || reviewPacket.counts.bytes !== proof.restoration.bytesCopied
    || reviewPacket.filesSha256 !== proof.restoration.sourceFilesSha256) throw new Error('Invalid native review graph');
  return { ...proof, reviewPacket };
}

async function collect(reference, control) {
  const restored = new Map();
  const observed = await preservation.collect(reference, { probe: async (copy, input) => {
    const checked = describe(await control.probeReviewRestoration(copy, input), input.requestId, reference);
    restored.set(copy, checked); return checked.packet;
  } });
  const snapshot = observed.snapshot;
  snapshot.contract = 'agentx.history-preservation/v3'; snapshot.scope = SCOPE;
  snapshot.copies = snapshot.copies.map(copy => copy.status === 'available' ? { ...copy,
    content: { ...copy.content, reviewPacket: restored.get(copy.copy).reviewPacket }, restoration: restored.get(copy.copy).restoration } : copy);
  if (snapshot.copies.every(copy => copy.status === 'available')
    && digest(snapshot.copies[0].content.reviewPacket) !== digest(snapshot.copies[1].content.reviewPacket)) {
    snapshot.blockers.push('native_review_packet_copy_mismatch'); snapshot.status = 'blocked';
  }
  return observed;
}

module.exports = { CONTRACT, SCOPE, describe, collect };

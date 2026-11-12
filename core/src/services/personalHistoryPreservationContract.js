'use strict';

const { randomUUID } = require('node:crypto');
const { digest } = require('./personalHistorySourceReviewSources');
const CONTRACT = 'secretary.archive-preservation/v1';
const HASH = /^[a-f0-9]{64}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
const LIMIT = 16 * 1024 * 1024;
const GAPS = Object.freeze(['native_semantic_acceptance_unavailable', 'native_decision_reconciliation_unavailable',
  'native_preservation_acceptance_unavailable', 'native_manifest_approval_binding_unavailable']);

function describe(value, requestId, reference) {
  const keys = ['contract', 'requestId', 'messageId', 'threadId', 'sourceSha256', 'machineIdSha256',
    'archiveIdSha256', 'raw', 'attachments', 'metadataSha256', 'partsDecoded', 'attachmentsDecoded'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || value.contract !== CONTRACT || value.requestId !== requestId || value.messageId !== reference.messageId
    || value.threadId !== reference.threadId || value.sourceSha256 !== reference.sourceSha256
    || ![value.machineIdSha256, value.archiveIdSha256, value.metadataSha256].every(isHash)
    || !value.raw || value.raw.sha256 !== reference.sourceSha256
    || !Number.isSafeInteger(value.raw.bytes) || value.raw.bytes < 1 || value.raw.bytes > LIMIT
    || !Array.isArray(value.attachments) || value.attachments.length > 128
    || !Number.isSafeInteger(value.partsDecoded) || value.partsDecoded < 1 || value.partsDecoded > 4096
    || !Number.isSafeInteger(value.attachmentsDecoded) || value.attachmentsDecoded < 0
    || value.attachmentsDecoded > value.partsDecoded) throw new Error('Invalid native preservation proof');
  let total = value.raw.bytes;
  const seen = new Set();
  const attachments = value.attachments.map(item => {
    if (!item || typeof item.partId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(item.partId)
      || seen.has(item.partId) || !isHash(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw new Error('Invalid native attachment proof');
    }
    seen.add(item.partId); total += item.bytes;
    return { partId: item.partId, sha256: item.sha256, bytes: item.bytes };
  }).sort((a, b) => a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0);
  if (total > LIMIT || value.attachmentsDecoded !== attachments.length) throw new Error('Incomplete native attachment proof');
  return { status: 'available', machineIdSha256: value.machineIdSha256, archiveIdSha256: value.archiveIdSha256,
    content: { messageId: reference.messageId, threadId: reference.threadId, sourceSha256: reference.sourceSha256,
      raw: { sha256: value.raw.sha256, bytes: value.raw.bytes }, attachments, metadataSha256: value.metadataSha256,
      partsDecoded: value.partsDecoded, attachmentsDecoded: value.attachmentsDecoded } };
}

async function collect(reference, control) {
  // A new server nonce on every observation prevents an old host response from
  // being treated as the requested fresh native read. It grants no write.
  const observationId = randomUUID();
  const copies = await Promise.all(['primary', 'mirror'].map(async copy => {
    try {
      const proof = await control.probe(copy, { requestId: observationId, messageId: reference.messageId,
        threadId: reference.threadId, sourceSha256: reference.sourceSha256 });
      return { copy, ...describe(proof, observationId, reference) };
    } catch (error) {
      return { copy, status: 'unavailable', code: /^SECRETARY_[A-Z0-9_]{1,70}$/.test(error.code || '')
        ? error.code : 'SECRETARY_PRESERVATION_UNAVAILABLE' };
    }
  }));
  const blockers = [];
  if (copies.some(copy => copy.status !== 'available')) blockers.push('native_copy_unavailable');
  else {
    if (copies[0].machineIdSha256 === copies[1].machineIdSha256) blockers.push('native_copies_on_same_machine');
    if (digest(copies[0].content) !== digest(copies[1].content)) blockers.push('native_copy_content_mismatch');
  }
  return { snapshot: { contract: 'agentx.history-preservation/v1', scope: 'selected-original-recorded-attachments-and-mime',
    reference, copies, status: blockers.length ? 'blocked' : 'verified_scope', blockers }, observationId };
}

module.exports = { CONTRACT, GAPS, collect, describe };

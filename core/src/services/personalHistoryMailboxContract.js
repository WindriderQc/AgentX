'use strict';

const { randomUUID } = require('node:crypto');
const { failure } = require('./personalHistorySourceReviewSources');
const CONTRACT = 'secretary.mailbox-source/v1';
const SCOPE = 'selected-live-message-raw-and-metadata';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{10,32}$/;
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,31})$/.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const invalid = () => failure('The exact live Gmail source is unavailable or invalid.', 503, 'HISTORY_MAILBOX_UNAVAILABLE');

function describe(value, requestId, reference) {
  if (!keys(value, ['contract', 'requestId', 'messageId', 'threadId', 'sourceSha256', 'accountSelectionSha256',
    'status', 'current', 'scope', 'mailboxEffects', 'approvalBound']) || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024
    || value.contract !== CONTRACT || value.requestId !== requestId || value.messageId !== reference.messageId
    || value.threadId !== reference.threadId || value.sourceSha256 !== reference.sourceSha256
    || !hash(value.accountSelectionSha256) || value.scope !== SCOPE || value.mailboxEffects !== 0 || value.approvalBound !== false
    || !['present', 'not_found'].includes(value.status)) throw invalid();
  const row = value.current;
  if (value.status === 'not_found') { if (row !== null) throw invalid(); }
  else if (!keys(row, ['messageId', 'threadId', 'internalDate', 'historyId', 'labelIds', 'raw'])
    || row.messageId !== reference.messageId || typeof row.threadId !== 'string' || !ID.test(row.threadId)
    || !decimal(row.internalDate) || BigInt(row.internalDate) > 253402300799999n || !decimal(row.historyId)
    || !keys(row.raw, ['sha256', 'bytes']) || !hash(row.raw.sha256) || !Number.isSafeInteger(row.raw.bytes)
    || row.raw.bytes < 1 || row.raw.bytes > 16 * 1024 * 1024
    || !Array.isArray(row.labelIds) || row.labelIds.length > 256
    || row.labelIds.some(label => typeof label !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(label))
    || new Set(row.labelIds).size !== row.labelIds.length
    || row.labelIds.some((label, index) => index && label <= row.labelIds[index - 1])) throw invalid();
  return { contract: CONTRACT, reference, accountSelectionSha256: value.accountSelectionSha256,
    status: value.status, current: row, scope: SCOPE };
}

async function collect(reference, control) {
  const requestId = randomUUID();
  try { return describe(await control.probe({ requestId, ...reference }), requestId, reference); }
  catch { throw invalid(); }
}

function coverage(mailbox) {
  const row = mailbox.current, blockers = [];
  if (!row) return { sourceMatches: null, direction: 'unknown', blockers: ['live_message_not_found'] };
  const sourceMatches = row.raw.sha256 === mailbox.reference.sourceSha256;
  if (!sourceMatches) blockers.push('live_source_hash_mismatch');
  if (row.threadId !== mailbox.reference.threadId) blockers.push('live_thread_mismatch');
  if (row.labelIds.includes('DRAFT')) blockers.push('live_message_is_draft');
  if (row.labelIds.includes('TRASH')) blockers.push('live_message_in_trash');
  // No SENT label does not prove receipt, authorship or identity.
  return { sourceMatches, direction: row.labelIds.includes('DRAFT') ? 'draft' : row.labelIds.includes('SENT') ? 'sent' : 'unknown', blockers };
}

module.exports = { CONTRACT, collect, describe, coverage };

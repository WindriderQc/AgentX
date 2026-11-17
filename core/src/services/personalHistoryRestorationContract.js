'use strict';

const preservation = require('./personalHistoryPreservationContract');
const CONTRACT = 'secretary.archive-restoration/v1';
const HASH = /^[a-f0-9]{64}$/;
const LIMIT = 16 * 1024 * 1024;

function describe(value, requestId, reference) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.contract !== CONTRACT) {
    throw new Error('Invalid native restoration proof');
  }
  const { restoration, ...original } = value;
  const packet = { ...original, contract: preservation.CONTRACT };
  const checked = preservation.describe(packet, requestId, reference);
  const keys = ['sourceFilesSha256', 'restoredFilesSha256', 'filesCopied', 'bytesCopied', 'temporaryCopyRemoved'];
  if (!restoration || typeof restoration !== 'object' || Array.isArray(restoration)
    || Object.keys(restoration).some(key => !keys.includes(key))
    || typeof restoration.sourceFilesSha256 !== 'string' || !HASH.test(restoration.sourceFilesSha256)
    || restoration.sourceFilesSha256 !== restoration.restoredFilesSha256
    || !Number.isSafeInteger(restoration.filesCopied) || restoration.filesCopied < 3
    || restoration.filesCopied > 3 + checked.content.attachments.length
    || !Number.isSafeInteger(restoration.bytesCopied) || restoration.bytesCopied < checked.content.raw.bytes
    || restoration.bytesCopied > LIMIT || restoration.temporaryCopyRemoved !== true) {
    throw new Error('Invalid native restoration proof');
  }
  return { packet, restoration: Object.fromEntries(keys.map(key => [key, restoration[key]])) };
}

async function collect(reference, control) {
  const restored = new Map();
  // Reuse the native two-machine/source/MIME checks, including their fresh nonce.
  // Only the restoration command can answer this mode; there is no v1 fallback.
  const observation = await preservation.collect(reference, { probe: async (copy, input) => {
    const value = await control.probeRestoration(copy, input);
    const checked = describe(value, input.requestId, reference);
    restored.set(copy, checked.restoration);
    return checked.packet;
  } });
  observation.snapshot.contract = 'agentx.history-preservation/v2';
  observation.snapshot.scope = 'selected-original-recorded-attachments-mime-and-temporary-disk-restore';
  observation.snapshot.copies = observation.snapshot.copies.map(copy => copy.status === 'available'
    ? { ...copy, restoration: restored.get(copy.copy) } : copy);
  return observation;
}

module.exports = { CONTRACT, describe, collect };

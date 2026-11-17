'use strict';
const { createHash } = require('node:crypto');
const MAX_SELECTION = 100, MAX_DECISIONS = 10000, PAGE_SIZE = 250, MAX_BYTES = 16 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });

// Canonical JSON preserves all JSON fields, including future Mixed fields, without
// truncation. Reject values JSON cannot preserve rather than silently dropping them.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  throw fail('PHOTO_EXPORT_UNSERIALIZABLE', 'Registry contains a value that cannot be preserved as JSON');
}
function validateSelection(input) {
  if (!input || input.audience !== 'owner') throw fail('PHOTO_EXPORT_OWNER_REQUIRED', 'Explicit owner export required');
  if (Object.keys(input).some(key => !['sha256s', 'audience'].includes(key)))
    throw fail('PHOTO_EXPORT_INVALID_SELECTION', 'Only content identities and owner audience are accepted');
  const ids = input.sha256s;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_SELECTION
      || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length)
    throw fail('PHOTO_EXPORT_INVALID_SELECTION', 'Select one to one hundred unique lowercase SHA-256 identities');
  return [...ids].sort();
}
function createPhotoPortableRegistry(deps = {}) {
  async function exportSelection(input) {
    const ids = validateSelection(input);
    // Lazy imports keep synthetic CPU tests independent of Mongo and runtime startup.
    const cards = deps.cards || require('../../../models/PhotoProcessingCard');
    const decisions = deps.decisions || require('../../../models/PhotoProcessingDecision');
    const entries = [];
    let decisionCount = 0, bytes = 0;
    for (const sha256 of ids) {
      const card = await cards.findById(sha256).lean();
      if (!card) throw fail('PHOTO_EXPORT_CARD_MISSING', 'A selected registry card is missing');
      if (card._id !== sha256) throw fail('PHOTO_EXPORT_IDENTITY_MISMATCH', 'Registry returned another identity');
      if (card.pendingDecision) throw fail('PHOTO_EXPORT_PENDING', 'Reconcile pending decisions before export');
      const history = [];
      let after;
      while (true) {
        const filter = { sha256, ...(after === undefined ? {} : { _id: { $gt: after } }) };
        const page = await decisions.find(filter).sort({ _id: 1 }).limit(PAGE_SIZE).lean();
        if (!Array.isArray(page) || page.length > PAGE_SIZE)
          throw fail('PHOTO_EXPORT_INVALID_PAGE', 'Registry returned an invalid decision page');
        for (const decision of page) {
          if (!decision || typeof decision._id !== 'string' || !decision._id || decision.sha256 !== sha256
              || (after !== undefined && decision._id <= after))
            throw fail('PHOTO_EXPORT_INVALID_PAGE', 'Decision identity or order does not match selection');
          if (decision.state !== 'completed') throw fail('PHOTO_EXPORT_PENDING', 'Reconcile incomplete decisions before export');
          if (++decisionCount > MAX_DECISIONS) throw fail('PHOTO_EXPORT_TOO_LARGE', 'Decision export exceeds its safety bound');
          const saved = canonical(decision);
          bytes += Buffer.byteLength(JSON.stringify(saved));
          if (bytes > MAX_BYTES) throw fail('PHOTO_EXPORT_TOO_LARGE', 'Registry export exceeds its byte safety bound');
          history.push(saved);
          after = decision._id;
        }
        if (page.length < PAGE_SIZE) break;
      }
      const savedCard = canonical(card);
      bytes += Buffer.byteLength(JSON.stringify(savedCard));
      if (bytes > MAX_BYTES) throw fail('PHOTO_EXPORT_TOO_LARGE', 'Registry export exceeds its byte safety bound');
      entries.push({ sha256, card: savedCard, decisions: history });
    }
    const payload = canonical({
      schema: 'agentx.photo-portable-registry/v1', audience: 'owner', identity: 'sha256',
      selection: ids, entries,
      completeness: { selectedRegistryCards: 'all-fields', selectedDecisionHistory: 'all-observed-completed-records',
        consistency: 'non-atomic-observation', migrationReady: false,
        limitations: ['Not a transactional database snapshot or writer fence.',
          'Immich metadata in cards is a bounded historical observation, not a complete Immich backup.',
          'Original media, XMP bytes, import receipts, projection journals and historical gallery exports are not included.',
          'No current file integrity, asset availability, album membership or sidecar reconciliation is verified.',
          'This private owner export is not authorized for family or public disclosure.'] }
    });
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw fail('PHOTO_EXPORT_TOO_LARGE', 'Registry export exceeds its byte safety bound');
    return { ...payload, manifestSha256: createHash('sha256').update(serialized).digest('hex') };
  }
  return { exportSelection };
}
module.exports = { createPhotoPortableRegistry, validateSelection, MAX_SELECTION, MAX_DECISIONS, PAGE_SIZE, MAX_BYTES };

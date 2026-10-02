'use strict';

// Corrections retain the original evidence, while the state revision refuses a
// stale browser write after a reset, deletion, review or another correction.
function createItemCorrection({ collection, read, keys, cleanText, fingerprint }) {
  return async function updateItem(userId, key, id, body = {}) {
    const fail = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
    if (!keys.includes(key)) throw fail('Unknown PsyX state section', 404, 'PSYX_STATE_SECTION_UNKNOWN');
    const text = cleanText(body.text, key === 'notes' ? 1000 : 500);
    if (!text) throw fail('text is required', 400, 'PSYX_STATE_TEXT_REQUIRED');
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      throw fail('expectedRevision is required', 400, 'PSYX_STATE_REVISION_REQUIRED');
    }
    const current = await read(userId);
    if (!current[key].some(item => item.id === id)) throw fail('PsyX memory item not found', 404, 'PSYX_STATE_ITEM_NOT_FOUND');
    const now = new Date().toISOString();
    const result = await collection.updateOne({ userId, revision: body.expectedRevision, [`${key}.id`]: id }, {
      $set: { [`${key}.$[item].text`]: text, [`${key}.$[item].fingerprint`]: fingerprint(key, text),
        [`${key}.$[item].updatedAt`]: now, [`${key}.$[item].correctedBy`]: 'user', updatedAt: new Date() },
      $inc: { revision: 1 }
    }, { arrayFilters: [{ 'item.id': id }] });
    if (!result.modifiedCount) throw fail('Memory changed; reload before correcting it', 409, 'PSYX_STATE_CONFLICT');
    return { state: await read(userId) };
  };
}

module.exports = { createItemCorrection };

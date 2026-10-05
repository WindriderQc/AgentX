'use strict';
const { SURFACES, catalogFor, defaultsFor } = require('./catalog');
const CONTRACT = 'agentx.conversation-preferences/v1';
const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'CONVERSATION_PREFERENCES_INVALID' });
const conflict = () => Object.assign(new Error('Ces réglages ont changé dans un autre onglet. Recharge avant de les enregistrer.'), { statusCode: 409, code: 'CONVERSATION_PREFERENCES_CONFLICT' });
function createConversationPreferences({ Model = require('../../../models/ConversationPreferences'), env = process.env } = {}) {
  let indexes;
  function forOwner({ ownerId, surface, defaults = {} }) {
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200 || !SURFACES.includes(surface)) throw invalid('Un espace de réglages exact est requis.');
    const scope = { ownerId, surface }, catalog = catalogFor(surface), initial = { ...defaultsFor(surface, env), ...defaults };
    const allowed = new Map(catalog.map(item => [item.key, item]));
    const view = row => ({ contract: CONTRACT, surface, revision: row?.revision || 0, defaults: initial,
      overrides: row?.values || {}, values: { ...initial, ...row?.values }, catalog });
    async function read() { return view(await Model.findOne(scope).lean()); }
    async function save(body) {
      if (!body || Object.keys(body).some(key => !['revision', 'values'].includes(key)) || !Number.isSafeInteger(body.revision) || body.revision < 0
        || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw invalid('Les réglages et leur version sont requis.');
      for (const [key, value] of Object.entries(body.values)) {
        const field = allowed.get(key);
        if (!field || (field.type === 'number' ? !Number.isFinite(value) || value < field.min || value > field.max || (field.step === 1 && !Number.isInteger(value)) : typeof value !== 'boolean')) throw invalid('Une option est inconnue ou sa valeur est invalide.');
      }
      if (Model.createIndexes) await (indexes ||= Model.createIndexes().catch(error => { indexes = null; throw error; }));
      let row;
      try {
        row = await Model.findOneAndUpdate({ ...scope, revision: body.revision || { $exists: false } },
          { $set: { ...scope, values: body.values, revision: body.revision + 1 } },
          { new: true, upsert: body.revision === 0, runValidators: true, setDefaultsOnInsert: true }).lean();
      } catch (error) { if (error.code === 11000) throw conflict(); throw error; }
      if (!row) throw conflict();
      return view(row);
    }
    return Object.freeze({ read, save });
  }
  return Object.freeze({ forOwner });
}
module.exports = { CONTRACT, createConversationPreferences };

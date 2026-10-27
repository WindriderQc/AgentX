'use strict';

// The owner's own screen-command phrases (#924). They live in Core so every
// owner device hears the same words. The route is under /private, which a
// family-pinned device never reaches; the browser and Core share one validator.
const { validate, MAX_CUSTOM } = require('./public/screen-commands');

const CONTRACT = 'agentx.screen-command-phrases/v1';
const OWNER = 'default';
const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'SCREEN_COMMANDS_INVALID' });
const conflict = () => Object.assign(new Error('Ces commandes ont changé dans un autre onglet. Recharge avant de les enregistrer.'),
  { statusCode: 409, code: 'SCREEN_COMMANDS_CONFLICT' });

function createScreenCommandPhrases({ Model = require('../../models/ScreenCommandPhrases') } = {}) {
  let indexes;
  const view = row => ({ contract: CONTRACT, revision: row?.revision || 0, limit: MAX_CUSTOM,
    phrases: (row?.phrases || []).map(({ phrase, action }) => ({ phrase, action })) });
  async function read() { return view(await Model.findOne({ ownerId: OWNER }).lean()); }
  async function save(body) {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['revision', 'phrases'].includes(key))
      || !Number.isSafeInteger(body.revision) || body.revision < 0) throw invalid('Les commandes et leur version sont requises.');
    const checked = validate(body.phrases);
    if (checked.error) throw invalid(checked.error);
    if (Model.createIndexes) await (indexes ||= Model.createIndexes().catch(error => { indexes = null; throw error; }));
    let row;
    try {
      row = await Model.findOneAndUpdate({ ownerId: OWNER, revision: body.revision || { $exists: false } },
        { $set: { ownerId: OWNER, phrases: checked.phrases, revision: body.revision + 1 } },
        { new: true, upsert: body.revision === 0, runValidators: true }).lean();
    } catch (error) { if (error.code === 11000) throw conflict(); throw error; }
    if (!row) throw conflict();
    return view(row);
  }
  return Object.freeze({ read, save });
}

function register(router, { service, envelope, fail }) {
  const handle = write => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return envelope(res, write ? await service.save(req.body) : await service.read()); }
    catch (error) {
      if (error.statusCode) return fail(res, error.statusCode, error.message, error.code);
      return fail(res, 503, 'Les commandes d’écran sont indisponibles. Réessaie plus tard.', 'SCREEN_COMMANDS_UNAVAILABLE');
    }
  };
  router.get('/private/screen-commands', handle(false));
  router.put('/private/screen-commands', handle(true));
}

module.exports = { CONTRACT, createScreenCommandPhrases, register };

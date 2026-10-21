'use strict';

const memory = require('../../src/services/memoryNoteService');

// The owner reads and corrects a kept souvenir under /api/secretary/souvenirs.
// This is an owner surface only: the Nestor consumer contract has no route to
// it, so a correction always comes from the owner's own click.
function registerSecretarySouvenirRoutes({ router, envelope, fail }) {
  const respond = async (res, action) => {
    try { res.set('Cache-Control', 'no-store'); return envelope(res, await action()); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'SOUVENIR_FAILED'); }
  };
  router.get('/souvenirs/:id', (req, res) => respond(res, async () => {
    const [note] = await memory.personal().souvenirs([req.params.id]);
    if (!note) throw Object.assign(new Error('Souvenir is unavailable'), { statusCode: 404, code: 'SOUVENIR_UNAVAILABLE' });
    return { authority: 'agentx.core', souvenir: note };
  }));
  router.post('/souvenirs/:id', (req, res) => respond(res, async () => {
    const body = req.body || {};
    const input = Object.fromEntries(['revision', 'eventDate', 'eventDatePrecision', 'people', 'places', 'text']
      .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
    const result = await memory.personal().editSouvenir(req.params.id, input);
    const { ok, authority, changed, ...souvenir } = result;
    return { authority, changed, souvenir };
  }));
}

module.exports = { registerSecretarySouvenirRoutes };

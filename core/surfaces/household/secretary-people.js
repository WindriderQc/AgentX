'use strict';

const people = require('../../src/services/peopleRegistryService');

// The owner's people registry under /api/secretary/people. Imports record
// observations; merges happen only when the owner accepts one, and can be undone.
function registerSecretaryPeopleRoutes({ router, envelope, fail }) {
  const respond = async (res, action) => {
    try { return envelope(res, await action()); }
    catch (error) { return fail(res, error.statusCode || 500, error.message, error.code || 'PEOPLE_REGISTRY_FAILED'); }
  };
  router.get('/people', (req, res) => respond(res, () => people.list(req.query)));
  router.get('/people/merges', (req, res) => respond(res, () => people.proposals(req.query)));
  router.post('/people/observations', (req, res) => respond(res, () => people.observe(req.body?.observations)));
  router.post('/people/merges/:id/accept', (req, res) => respond(res, () => people.accept(req.params.id, req.body || {})));
  router.post('/people/merges/:id/dismiss', (req, res) => respond(res, () => people.dismiss(req.params.id, req.body || {})));
  router.post('/people/merges/:id/undo', (req, res) => respond(res, () => people.undo(req.params.id, req.body || {})));
  router.get('/people/:id', (req, res) => respond(res, () => people.show(req.params.id)));
}

module.exports = { registerSecretaryPeopleRoutes };

'use strict';

function registerSecretaryDossierRoutes({ router, envelope, fail, dossiers = require('../../src/services/personalTaskDossierService') }) {
  router.post('/tasks/dossier', async (req, res) => {
    try { return envelope(res, await dossiers.operate(req.body || {})); }
    catch (error) { return fail(res, error.status || 500, error.message, error.code || 'PERSONAL_DOSSIER_FAILED'); }
  });
  router.get('/tasks/dossier/:id', async (req, res) => {
    try { return envelope(res, await dossiers.get(req.params.id)); }
    catch (error) { return fail(res, error.status || 500, error.message, error.code || 'PERSONAL_DOSSIER_FAILED'); }
  });
  // The human page chooses one exact proposal. No MCP operation invokes this.
  router.post('/tasks/dossier/:id/decision', async (req, res) => {
    try { return envelope(res, await dossiers.decide({ ...req.body, id: req.params.id })); }
    catch (error) { return fail(res, error.status || 500, error.message, error.code || 'PERSONAL_DOSSIER_DECISION_FAILED'); }
  });
}
module.exports = { registerSecretaryDossierRoutes };

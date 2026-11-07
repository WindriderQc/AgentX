'use strict';
const path = require('node:path');
const { createDocumentCandidates } = require('../../src/services/householdDocumentCandidates');
const { fingerprint } = require('../../src/services/householdDocumentArchive');
const knowledge = require('./nestor-knowledge');

// A human review entry on the existing personal LAN boundary. There is no
// family API, MCP action, model argument or claimed adult identity here.
function createKnowledgeTarget(knowledgeState, load = () => knowledge.loadFailClosed()) {
  return () => {
    const state = load();
    const config = state.config;
    if (!config || config.status !== 'active' || !config.retrieval.enabled
      || !config.householdDocuments?.lanes.includes('family')) return null;
    // Family retrieval uses its startup snapshot. A changed file cannot silently
    // redirect promotion into a source that the running reader does not serve.
    if (!knowledgeState?.config || fingerprint(config) !== fingerprint(knowledgeState.config)) return null;
    return { source: config.householdDocuments.source, lanes: config.householdDocuments.lanes,
      revision: fingerprint(config) };
  };
}
function registerDocumentCandidateRoutes({ app, jsonParser, service, knowledgeState } = {}) {
  const candidates = service || createDocumentCandidates({ targetSource: createKnowledgeTarget(knowledgeState) });
  app.get('/dad/documents', require('../../src/ui/productShell').surfacePage(app,
    path.join(__dirname, 'pages/document-candidates.html'), { activePage: 'dad-documents' }));
  const base = '/api/voice-personas/private/document-candidates';
  const route = handler => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json({ ok: true, data: await handler(req) }); }
    catch (error) {
      res.status(error.statusCode || 503).json({ ok: false, code: error.code || 'HOUSEHOLD_DOCUMENT_UNAVAILABLE',
        message: error.statusCode ? error.message : 'Revue indisponible. Actualisez le candidat pour consulter son état.' });
    }
  };
  const input = (req, keys) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !keys.includes(key))) {
      throw Object.assign(new Error('Champs de revue invalides.'), { statusCode: 400 });
    }
    return req.body;
  };
  app.get(`${base}/sources`, route(req => candidates.sources(req.query)));
  app.get(base, route(req => candidates.list(req.query)));
  app.get(`${base}/:id`, route(req => candidates.get(req.params.id)));
  app.post(base, jsonParser, route(req => candidates.stage(input(req, ['sourceId']))));
  app.post(`${base}/:id/review`, jsonParser, route(req => candidates.review(req.params.id,
    input(req, ['expectedRevision', 'decision', 'reviewer']))));
  app.post(`${base}/:id/promote`, jsonParser, route(req => candidates.promote(req.params.id,
    input(req, ['expectedRevision', 'requestId', 'confirmation']))));
}
module.exports = { registerDocumentCandidateRoutes, createKnowledgeTarget };

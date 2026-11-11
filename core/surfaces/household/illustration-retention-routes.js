'use strict';

// Family's existing frame keeps exact native retention identities; this is not
// another mode or another archive. Parent household middleware owns access.
const storage = require('../../src/services/images/illustrationStorage');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const scopeFor = sessionId => ({ surface: 'household', sessionId, packId: 'kidx_nestor', scopeId: 'family' });
function register(router, { service, view }) {
  const base = '/family/sessions/:sessionId/images';
  const wrap = handler => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(req.params.sessionId || '') || req.params.id && !UUID.test(req.params.id)) {
        throw Object.assign(new Error('Unknown image conversation.'), { statusCode: 404 });
      }
      await handler(req, res, scopeFor(req.params.sessionId));
    } catch (error) {
      res.status(error.statusCode || 503).json({ ok: false, message: 'Retention could not be confirmed. Read the original request identity.' });
    }
  };
  router.get(base + '/retention/end', wrap(async (req, res, scope) => {
    res.json({ ok: true, receipt: await storage.endReceipt(scope, req.query.requestId) });
  }));
  router.post(base + '/retention/end', wrap(async (req, res, scope) => {
    if (Object.keys(req.body || {}).some(key => !['epoch', 'requestId'].includes(key))) throw Object.assign(new Error('Invalid end request.'), { statusCode: 400 });
    res.json({ ok: true, ...await storage.end(scope, req.body) });
  }));
  router.get(base + '/:id/keep', wrap(async (req, res, scope) => {
    res.json({ ok: true, receipt: await storage.keepReceipt(req.params.id, scope, req.query.requestId),
      operation: view(await service.getForConversation(req.params.id, scope), scope) });
  }));
  router.post(base + '/:id/keep', wrap(async (req, res, scope) => {
    if (Object.keys(req.body || {}).some(key => key !== 'requestId')) throw Object.assign(new Error('Invalid keep request.'), { statusCode: 400 });
    await storage.keep(req.params.id, scope, req.body?.requestId);
    res.json({ ok: true, receipt: await storage.keepReceipt(req.params.id, scope, req.body.requestId),
      operation: view(await service.getForConversation(req.params.id, scope), scope) });
  }));
}
module.exports = { register };

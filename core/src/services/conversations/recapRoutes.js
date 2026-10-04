'use strict';

function registerRecapRoutes(router, { base, serviceFor, generate, busy = () => false, allowDraft = async () => true }) {
  const route = operation => async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const service = serviceFor(req, res);
      const data = await operation(service, req, res);
      return res.json({ ok: true, status: 'success', data });
    } catch (error) {
      if (!error.statusCode) return next(error);
      return res.status(error.statusCode).json({ ok: false, code: error.code, message: error.message });
    }
  };
  const idle = (req, res) => {
    if (busy(req, res)) throw Object.assign(new Error('Attends la fin de la réponse avant de faire le point.'),
      { code: 'CONVERSATION_RECAP_BUSY', statusCode: 409 });
  };
  router.get(`${base}/recap/latest`, route(service => service.latest()));
  router.get(`${base}/:id/recap`, route(async (service, req, res) => ({ ...await service.read(req.params.id), canDraft: await allowDraft(req, res) })));
  router.put(`${base}/:id/recap`, route(async (service, req, res) => {
    idle(req, res);
    return { ...await service.save(req.params.id, req.body), canDraft: await allowDraft(req, res) };
  }));
  router.post(`${base}/:id/recap/draft`, route(async (service, req, res) => {
    idle(req, res);
    if (!await allowDraft(req, res)) throw Object.assign(new Error('La proposition automatique est désactivée dans les réglages. Tu peux écrire ton point directement.'),
      { code: 'CONVERSATION_RECAP_DRAFT_DISABLED', statusCode: 409 });
    return { ...await service.draft(req.params.id, generate), canDraft: await allowDraft(req, res) };
  }));
}
module.exports = { registerRecapRoutes };

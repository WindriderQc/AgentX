'use strict';

function registerRecapRoutes(router, { base, serviceFor, generate, busy = () => false }) {
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
  router.get(`${base}/:id/recap`, route((service, req) => service.read(req.params.id)));
  router.put(`${base}/:id/recap`, route((service, req, res) => { idle(req, res); return service.save(req.params.id, req.body); }));
  router.post(`${base}/:id/recap/draft`, route((service, req, res) => { idle(req, res); return service.draft(req.params.id, generate); }));
}
module.exports = { registerRecapRoutes };

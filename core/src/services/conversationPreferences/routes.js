'use strict';
function registerPreferenceRoutes(router, { base, serviceFor, onSaved = async () => {}, decorate = view => view }) {
  const handler = save => async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const service = serviceFor(req, res);
      const view = save ? await service.save(req.body) : await service.read();
      if (save) await onSaved(req, res, view);
      res.json({ ok: true, status: 'success', data: await decorate(view, req, res) });
    } catch (error) {
      if (!error.statusCode) return next(error);
      res.status(error.statusCode).json({ ok: false, code: error.code, message: error.message });
    }
  };
  router.get(base, handler(false)); router.put(base, handler(true));
}
module.exports = { registerPreferenceRoutes };

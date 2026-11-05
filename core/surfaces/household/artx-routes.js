'use strict';

function registerArtxRoutes(router, artx) {
  if (!artx) return;
  for (const [path, operation] of [['idle', 'idle'], ['activity', 'activity']]) {
    router.post('/ambient/' + path, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        const data = await artx[operation](operation === 'activity' ? req.body?.displayId : req.body || {});
        return res.json({ ok: true, status: 'success', data });
      } catch (error) {
        return res.status(error.status || 503).json({ ok: false, status: 'error', code: error.code || 'ARTX_UNAVAILABLE' });
      }
    });
  }
}

module.exports = { registerArtxRoutes };

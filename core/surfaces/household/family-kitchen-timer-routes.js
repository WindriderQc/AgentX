'use strict';

function registerKitchenTimer(router, timer) {
  const reply = operation => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json({ ok: true, data: await operation(req) }); }
    catch { return res.status(503).json({ ok: false, status: 'error',
      code: 'FAMILY_TIMER_UNAVAILABLE', message: 'Kitchen timer storage is unavailable' }); }
  };
  router.get('/kitchen-timer', reply(() => timer.read()));
  router.post('/kitchen-timer/alert', reply(req => timer.claimAlert(req.body?.id)));
}

module.exports = { registerKitchenTimer };

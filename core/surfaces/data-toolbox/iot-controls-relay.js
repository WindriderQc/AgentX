'use strict';

const rules = require('../../../shared/iotControlRules');
function mount(router, { relay, fetchData, devicePath }) {
  const profilePath = req => `/api/v1/iot/profiles/${encodeURIComponent(rules.profileName(req.params.name))}`;
  const timerPath = req => {
    const io = rules.gpio(Number(req.params.io));
    if (String(io) !== req.params.io) rules.fail('Invalid GPIO path');
    return `${devicePath(req)}/timers/${io}`;
  };
  const resolveBody = body => {
    rules.object(body, ['observedSerial', 'observedBootId']);
    rules.revision(body.observedSerial);
    if (typeof body.observedBootId !== 'string' || !/^[a-f0-9]{8,32}$/i.test(body.observedBootId)) rules.fail('Invalid boot identity');
    return body;
  };
  function write(method, path, validate, publishes = false) {
    return async (req, res) => {
      try {
        const target = path(req); const payload = validate(req.body);
        const { response, body } = await fetchData(target, { method, payload });
        return res.status(response.status).json(body);
      } catch (error) {
        const status = error.statusCode || error.status || 502;
        return res.status(status).json({ status: 'error', code: 'IOT_CONTROL_REQUEST_FAILED',
          message: status < 500 ? error.message : publishes
            ? 'Application outcome unknown. Refresh device controls to recover the original request; do not send it again.'
            : 'Save outcome unknown. Refresh before saving again.' });
      }
    };
  }
  router.get('/iot/profiles', relay(() => '/api/v1/iot/profiles'));
  router.put('/iot/profiles/:name', write('PUT', profilePath, rules.validateProfile));
  router.get('/iot/devices/:id/controls', relay(req => `${devicePath(req)}/controls`));
  router.put('/iot/devices/:id/profile', write('PUT', req => `${devicePath(req)}/profile`, rules.validateAssignment));
  router.post('/iot/devices/:id/profile/apply', write('POST', req => `${devicePath(req)}/profile/apply`, body => rules.validateApply(body, true), true));
  router.put('/iot/devices/:id/timers/:io', write('PUT', timerPath, rules.validateTimer));
  router.post('/iot/devices/:id/timers/:io/apply', write('POST', req => `${timerPath(req)}/apply`, rules.validateApply, true));
  router.post('/iot/devices/:id/operations/:requestId/resolve', write('POST', req => {
    rules.validateApply({ requestId: req.params.requestId, revision: 0 });
    return `${devicePath(req)}/operations/${req.params.requestId}/resolve`;
  }, resolveBody));
}
module.exports = { mount };

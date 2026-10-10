'use strict';

const { isDeviceId, validateCommand, validatePatch } = require('../../../shared/iotDeviceRules');

function devicePath(req) {
  if (!isDeviceId(req.params.id)) throw Object.assign(new Error('Invalid IoT device id'), { status: 400 });
  return `/api/v1/iot/devices/${encodeURIComponent(req.params.id)}`;
}

function mount(router, { relay, fetchData }) {
  router.get('/iot/status', relay(() => '/api/v1/iot/status'));
  router.get('/iot/devices', relay(() => '/api/v1/iot/devices'));
  router.get('/iot/devices/:id', relay(devicePath));
  router.get('/iot/devices/:id/live', relay(req => `${devicePath(req)}/live`, { measure: { maxLength: 1600 } }));
  router.get('/iot/devices/:id/history', relay(req => `${devicePath(req)}/history`, {
    measure: { maxLength: 600 }, from: { maxLength: 40 }, to: { maxLength: 40 },
    resolution: { values: ['auto', 'minute', '5min', '30min', 'hour', '2hour', 'day'] }
  }));
  function write(validate, method, suffix) {
    return async (req, res) => {
      try {
        const path = devicePath(req) + suffix;
        const checked = validate(req.body);
        const payload = method === 'POST'
          ? { command: checked.command, ...(checked.gpio === null ? {} : { gpio: checked.gpio }) } : checked;
        const { response, body } = await fetchData(path, { method, payload });
        return res.status(response.status).json(body);
      } catch (error) {
        const status = error.statusCode || error.status || 502;
        const uncertain = method === 'POST' && status >= 500;
        return res.status(status).json({ ok: false, status: 'error',
          code: status === 400 ? 'INVALID_IOT_REQUEST' : 'DATA_UNAVAILABLE',
          message: status < 500 ? error.message : uncertain
            ? 'Command outcome unknown: Data could not confirm it. Check the device before sending another command.'
            : 'Data could not confirm the save. Refresh the device record before saving again.' });
      }
    };
  }
  router.patch('/iot/devices/:id', write(validatePatch, 'PATCH', ''));
  router.post('/iot/devices/:id/commands', write(validateCommand, 'POST', '/commands'));
}

module.exports = { mount, devicePath };

'use strict';

const iot = require('../services/iot');

// The service marks what the caller can fix (400), an unknown device (404), a
// missing broker link (503) and an unconfirmed write (504); anything else is a
// server error.
function handle(work) {
  return async (req, res, next) => {
    try {
      return res.json({ status: 'success', data: await work(req) });
    } catch (error) {
      if ([400, 404, 503, 504].includes(error.statusCode)) {
        return res.status(error.statusCode).json({ status: 'error', message: error.message });
      }
      return next(error);
    }
  };
}

const db = (req) => req.app.locals.db;

module.exports = {
  status: handle((req) => iot.status(db(req))),
  listDevices: handle(async (req) => {
    const devices = await iot.listDevices(db(req));
    return { devices, count: devices.length };
  }),
  getDevice: handle((req) => iot.getDevice(db(req), req.params.id)),
  patchDevice: handle((req) => iot.patchDevice(db(req), req.params.id, req.body)),
  history: handle((req) => iot.readHistory(db(req), req.params.id, req.query)),
  live: handle((req) => iot.readLive(db(req), req.params.id, req.query)),
  command: handle((req) => iot.sendCommand(db(req), req.params.id, req.body))
};

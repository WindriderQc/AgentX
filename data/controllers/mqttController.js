'use strict';

const mqttMonitor = require('../services/mqttMonitor');

// The monitor marks what the caller can fix (400), a missing broker link (503)
// and an unconfirmed write (504); anything else is a server error.
function handle(work) {
  return async (req, res, next) => {
    try {
      return res.json({ status: 'success', data: await work(req) });
    } catch (error) {
      if ([400, 503, 504].includes(error.statusCode)) {
        return res.status(error.statusCode).json({ status: 'error', message: error.message });
      }
      return next(error);
    }
  };
}

const status = handle(() => mqttMonitor.status());

const messages = handle((req) => mqttMonitor.messages({
  since: req.query.since,
  limit: req.query.limit,
  topic: req.query.topic,
  exclude: req.query.exclude
}));

const publish = handle((req) => mqttMonitor.publish(req.body));

module.exports = { status, messages, publish };

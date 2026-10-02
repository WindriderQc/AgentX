'use strict';

const hardware = require('../services/hardwareTelemetryService');

function handle(work) {
  return async (req, res, next) => {
    try {
      return res.json({ status: 'success', data: await work(req) });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({ status: 'error', message: error.message });
      }
      return next(error);
    }
  };
}

const heartbeat = handle(async (req) => {
  const collector = await hardware.registerCollector(req.app.locals.db, req.body || {});
  return { collector_id: collector.collectorId, heartbeat_at: new Date().toISOString() };
});

const ingestSamples = handle(req => hardware.ingestSamples(req.app.locals.db, req.body || {}));

const listCollectors = handle(async (req) => {
  const collectors = await hardware.listCollectors(req.app.locals.db);
  return { collectors, active: collectors.filter(collector => collector.active).length };
});

const latest = handle(async (req) => {
  const hosts = await hardware.latest(req.app.locals.db, {
    hostId: req.query.hostId,
    collectorId: req.query.collectorId
  });
  return {
    hosts,
    total: hosts.length,
    fresh: hosts.filter(host => host.freshness === 'fresh').length,
    observedAt: new Date().toISOString()
  };
});

const history = handle(req => hardware.history(req.app.locals.db, req.query || {}));

module.exports = { heartbeat, ingestSamples, listCollectors, latest, history };

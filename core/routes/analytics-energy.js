'use strict';

const express = require('express');
const InferenceLog = require('../models/InferenceLog');
const { fetchData } = require('../src/services/dataServiceClient');
const { createOperationsService } = require('../src/services/operationsJobsService');
const energy = require('../src/services/energyCorrelationService');

function configuration(env) {
  const configured = env ? env.ENERGY_IOT_DEVICE_ID : process.env.ENERGY_IOT_DEVICE_ID;
  const deviceId = String(configured || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(deviceId)) return null;
  return { deviceId };
}

function createRouter(deps = {}) {
  const router = express.Router();
  const data = deps.fetchData || fetchData;
  const findInferences = deps.findInferences || (filter => InferenceLog.find(filter).sort({ timestamp: -1 }).limit(1500).lean());
  const countInferences = deps.countInferences || (filter => InferenceLog.countDocuments(filter));
  const readOperations = deps.readOperations || (async () => {
    const result = await createOperationsService().status({ refresh: false });
    return result.available ? (result.history || []).map(row => ({ ...row,
      jobName: result.jobs?.find(job => job.id === row.jobId)?.name || row.jobId,
      hostLabel: result.jobs?.find(job => job.id === row.jobId)?.hostLabel || null
    })) : [];
  });

  router.get('/', async (req, res) => {
    const configured = configuration(deps.env || process.env);
    if (!configured) return res.status(503).json({ status: 'error', code: 'ENERGY_NOT_CONFIGURED', message: 'ENERGY_IOT_DEVICE_ID is not configured.' });
    const range = energy.rangeFor(req.query.window);
    const query = new URLSearchParams({ measure: energy.MEASURES.join(','), from: range.from.toISOString(), to: range.to.toISOString(), resolution: 'auto' }).toString();
    try {
      const inferenceFilter = { timestamp: { $gte: range.from, $lte: range.to } };
      const [historyAnswer, liveAnswer, inferences, inferenceCount, operations] = await Promise.all([
        data(`/api/v1/iot/devices/${encodeURIComponent(configured.deviceId)}/history`, { query }),
        data(`/api/v1/iot/devices/${encodeURIComponent(configured.deviceId)}/live`, { query: `measure=${energy.MEASURES.join(',')}` }),
        findInferences(inferenceFilter),
        countInferences(inferenceFilter),
        readOperations().catch(() => [])
      ]);
      if (!historyAnswer.response.ok) return res.status(historyAnswer.response.status).json(historyAnswer.body);
      if (!liveAnswer.response.ok) return res.status(liveAnswer.response.status).json(liveAnswer.body);
      return res.json({ status: 'success', data: energy.compose({
        history: historyAnswer.body.data, live: liveAnswer.body.data, inferences, inferenceCount, operations, range, deviceId: configured.deviceId
      }) });
    } catch (error) {
      return res.status(502).json({ status: 'error', code: 'ENERGY_DATA_UNAVAILABLE', message: error.message });
    }
  });
  return router;
}

module.exports = { createRouter, configuration };

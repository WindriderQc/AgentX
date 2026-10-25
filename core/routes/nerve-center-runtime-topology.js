'use strict';
const router = require('express').Router();
const logger = require('../config/logger');
const { describeTopology } = require('../src/services/runtimeTopologyService');
const { getTopologySwitchService } = require('../src/services/runtimeTopologySwitchService');
const { createActuatorClient } = require('../src/services/runtimeTopologyActuator');
const { defaultParking } = require('../src/services/runtimeTopologyParking');
const { requestPrincipal } = require('../src/helpers/requestCaller');

function refusal(res, error, fallbackCode) {
  const status = Number(error.statusCode) || 500;
  if (status >= 500) logger.error('[NerveCenter] runtime topology request failed', { error: error.message });
  res.status(status).json({ status: 'error', code: error.code || fallbackCode,
    message: status >= 500 ? 'Runtime topology unavailable' : error.message, ...(error.data ? { data: error.data } : {}) });
}

// The declared topology modes, which one runs, and the switch state per group.
router.get('/runtime-topology', async (_req, res) => {
  try {
    const data = await describeTopology();
    if (data.configured && data.valid) {
      const service = getTopologySwitchService();
      const actuators = createActuatorClient();
      for (const group of data.groups) {
        const [last] = await service.recent(group.id, 1);
        group.switch = {
          actuatorConfigured: actuators.configured(group.id),
          intendedMode: defaultParking.intendedMode(group.id),
          inProgress: defaultParking.switchInProgress(group.id),
          last: last || null
        };
      }
      data.parkedHosts = defaultParking.parkedHosts();
    }
    res.json({ status: 'success', data });
  } catch (error) {
    refusal(res, error, 'RUNTIME_TOPOLOGY_READ_FAILED');
  }
});

// Request a switch (#360 phase 4). Idempotent by requestId: a lost answer is
// read back with GET .../switch/:requestId, never by sending another switch.
router.post('/runtime-topology/switch', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await getTopologySwitchService().request({
      groupId: body.groupId, targetMode: body.targetMode, expectedActiveMode: body.expectedActiveMode,
      requestId: body.requestId, principal: requestPrincipal(req), source: 'api'
    });
    const service = getTopologySwitchService();
    res.status(result.idempotent || result.alreadyActive ? 200 : 202).json({
      status: 'success', idempotent: Boolean(result.idempotent), data: service.present(result.record)
    });
  } catch (error) {
    refusal(res, error, 'TOPOLOGY_SWITCH_FAILED');
  }
});

router.get('/runtime-topology/switch/:requestId', async (req, res) => {
  try {
    const record = await getTopologySwitchService().get(String(req.params.requestId || '').slice(0, 120));
    if (!record) return res.status(404).json({ status: 'error', code: 'TOPOLOGY_SWITCH_NOT_FOUND', message: 'No such switch' });
    res.json({ status: 'success', data: record });
  } catch (error) {
    refusal(res, error, 'TOPOLOGY_SWITCH_READ_FAILED');
  }
});

router.get('/runtime-topology/switches', async (req, res) => {
  try {
    const groupId = typeof req.query.groupId === 'string' ? req.query.groupId.slice(0, 64) : null;
    res.json({ status: 'success', data: await getTopologySwitchService().recent(groupId, req.query.limit) });
  } catch (error) {
    refusal(res, error, 'TOPOLOGY_SWITCH_READ_FAILED');
  }
});

module.exports = router;

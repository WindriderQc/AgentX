'use strict';

// The Household device acceptance API (/api/household/device-acceptance):
// real-device voice and audio acceptance receipts.

const deviceAcceptance = require('./device-acceptance');

function registerDeviceAcceptanceRoutes(app, {
  express, standardJsonParser, models, envelope, fail, cleanText
}) {
  const device = express.Router();
  device.use(standardJsonParser);
  device.get('/contract', async (_req, res) => {
    try {
      const latest = await models.DeviceAcceptance.findOne({ phase: deviceAcceptance.PHASE })
        .sort({ completedAt: -1 })
        .lean();
      return envelope(res, deviceAcceptance.contract(latest));
    } catch (error) {
      return fail(res, 500, error.message, 'DEVICE_ACCEPTANCE_READ_FAILED');
    }
  });
  device.get('/latest', async (_req, res) => {
    try {
      const latest = await models.DeviceAcceptance.findOne({ phase: deviceAcceptance.PHASE })
        .sort({ completedAt: -1 })
        .lean();
      return envelope(res, { phase: deviceAcceptance.PHASE, latest: deviceAcceptance.publicReceipt(latest) });
    } catch (error) {
      return fail(res, 500, error.message, 'DEVICE_ACCEPTANCE_READ_FAILED');
    }
  });
  device.post('/receipts', async (req, res) => {
    try {
      const receipt = deviceAcceptance.buildReceipt(req.body || {});
      const saved = await models.DeviceAcceptance.create(receipt);
      return envelope(res, { receipt: deviceAcceptance.publicReceipt(saved) }, 201);
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await models.DeviceAcceptance.findOne({ runId: cleanText(req.body?.runId, 80) }).lean().catch(() => null);
        if (existing) {
          return envelope(res, { receipt: deviceAcceptance.publicReceipt(existing), alreadyRecorded: true });
        }
        return fail(res, 409, 'This physical acceptance run was already recorded', 'DEVICE_ACCEPTANCE_DUPLICATE');
      }
      return fail(res, error.status || 500, error.message, error.code || 'DEVICE_ACCEPTANCE_WRITE_FAILED', error.details);
    }
  });
  app.use('/api/household/device-acceptance', device);
}

module.exports = { registerDeviceAcceptanceRoutes };

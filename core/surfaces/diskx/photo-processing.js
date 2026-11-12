'use strict';
const { createPhotoProcessingService } = require('../../src/services/photos/photoProcessingService');
function registerPhotoProcessing({ app, express, service = createPhotoProcessingService() }) {
  const failure = (res, error) => res.status(/NOT_CONFIGURED/.test(error.code || '') ? 503
    : /INVALID/.test(error.code || '') ? 400 : 409).json({ ok: false, code: error.code || 'PHOTO_PROCESSING_UNAVAILABLE', message: error.message });
  app.get('/api/phone-media/processing', async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { res.json({ ok: true, data: service.status() }); } catch (error) { failure(res, error); }
  });
  app.post('/api/phone-media/processing', express.json({ limit: '16kb' }), async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const fields = { page: ['runId', 'items'], enqueue: ['operationId', 'runId', 'items'], enqueueRun: ['operationId', 'runId'],
        review: ['writeId', 'sha256', 'expectedRevision', 'approved', 'description', 'tags'],
        frame: ['writeId', 'sha256', 'expectedRevision', 'selected'] };
      const input = req.body;
      if (!input || !Object.hasOwn(fields, input.op) || Object.keys(input).some(k => k !== 'op' && !fields[input.op].includes(k)))
        throw Object.assign(new Error('Invalid photo processing action'), { code: 'INVALID_ACTION' });
      res.json({ ok: true, data: await service[input.op](input) });
    } catch (error) { failure(res, error); }
  });
}
module.exports = { registerPhotoProcessing };

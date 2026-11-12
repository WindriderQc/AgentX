'use strict';

const fs = require('node:fs'),
  path = require('node:path');
const { createPhoneWorkbenchBridge } = require('../../src/services/photos/phoneWorkbenchBridge');
const { id } = require('../../src/services/photos/phoneLibrary');

const READS = new Set(['status', 'devices', 'runs', 'page', 'cleanupStatus']);
function registerPhone({ app, express, bridge = createPhoneWorkbenchBridge(), processing }) {
  require('./photo-processing').registerPhotoProcessing({ app, express, service: processing });
  const answer = (res, error) =>
    res
      .status(
        error.code === 'PHONE_NOT_CONFIGURED'
          ? 503
          : /INVALID|CONFIRMATION/.test(error.code || '')
            ? 400
            : 409,
      )
      .json({ ok: false, code: error.code || 'PHONE_UNAVAILABLE', message: error.message });
  app.get('/diskx/phone', (_req, res) =>
    res
      .set('Cache-Control', 'no-store')
      .type('html')
      .send(fs.readFileSync(path.join(__dirname, 'public', 'phone.html'), 'utf8')),
  );
  app.get('/api/phone-media', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!READS.has(req.query.op))
        throw Object.assign(new Error('Invalid phone query'), { code: 'INVALID_ACTION' });
      const allowed = {
        status: [],
        devices: [],
        runs: [],
        page: ['runId', 'offset', 'limit', 'search', 'order'],
        cleanupStatus: ['planId'],
      }[req.query.op];
      if (Object.keys(req.query).some((k) => k !== 'op' && !allowed.includes(k)))
        throw Object.assign(new Error('Unknown query field'), { code: 'INVALID_QUERY' });
      return res.json({ ok: true, data: await bridge.call({ ...req.query }) });
    } catch (e) {
      return answer(res, e);
    }
  });
  app.post('/api/phone-media', express.json({ limit: '16kb' }), async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const input = req.body;
      const allowed = {
        start: ['requestId', 'kind', 'resume', 'deviceId', 'planId', 'digest', 'confirmation'],
        review: ['runId', 'requestId', 'writeId', 'expectedRevision', 'choice'],
        prepare: ['runId', 'items', 'planId'],
        reconcile: ['requestId'],
      };
      if (
        !input ||
        !Object.hasOwn(allowed, input.op) ||
        Object.keys(input).some((k) => k !== 'op' && !allowed[input.op].includes(k))
      )
        throw Object.assign(new Error('Invalid phone action'), { code: 'INVALID_ACTION' });
      if (input.op === 'prepare' && (!Array.isArray(input.items) || input.items.length > 100))
        throw Object.assign(new Error('Select at most 100 files'), { code: 'INVALID_SELECTION' });
      return res.json({ ok: true, data: await bridge.call(input) });
    } catch (e) {
      return answer(res, e);
    }
  });
  app.get('/api/phone-media/preview/:runId/:requestId', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const result = await bridge.call({
        op: 'preview',
        runId: id(req.params.runId),
        requestId: id(req.params.requestId),
      });
      if (typeof result.bytes !== 'string' || result.bytes.length > 12 * 1024 * 1024)
        throw new Error('Invalid preview');
      const bytes = await require('sharp')(Buffer.from(result.bytes, 'base64'), {
        limitInputPixels: 40000000,
      })
        .rotate()
        .resize({ width: 480, height: 360, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      return res.type('jpeg').send(bytes);
    } catch {
      res.status(404).end();
    }
  });
}
module.exports = { registerPhone };

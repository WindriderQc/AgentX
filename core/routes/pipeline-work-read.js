'use strict';
const router = require('express').Router();
const envelope = require('../src/helpers/responseEnvelope');
const service = require('../src/services/pipelineWorkReadService');
function argumentsFor(query, allowed) {
  const input = {};
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key) || typeof value !== 'string') throw Object.assign(new Error('Invalid read arguments.'), { status: 400, code: 'INVALID_ARGUMENTS' });
    input[key] = ['limit', 'offset', 'pageChars'].includes(key) ? Number(value) : value;
  }
  return input;
}
router.get('/work', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { return envelope.success(res, await service.list(argumentsFor(req.query, ['query', 'status', 'limit', 'offset']))); }
  catch (error) { return envelope.error(res, error.status || 500, error.message, error.code); }
});
router.get('/tasks/:id/dossier', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { return envelope.success(res, await service.dossier({ pipelineId: req.params.id,
    ...argumentsFor(req.query, ['offset', 'pageChars', 'expectedHash']) })); }
  catch (error) { return envelope.error(res, error.status || 500, error.message, error.code); }
});
module.exports = router;

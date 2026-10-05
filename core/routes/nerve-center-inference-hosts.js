'use strict';

/**
 * Nerve Center — inference host registry.
 *
 * Lists every Ollama endpoint (env bootstrap and registered), registers new
 * LAN endpoints, edits residency and concurrency, removes registered ones.
 * Mounted at `/api/nerve-center`. Household-entry requests already need an
 * private LAN access; confirmations and runtime constraints still apply.
 */

const express = require('express');
const registry = require('../src/services/inferenceHostRegistry');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

const router = express.Router();

function fail(res, error) {
  if (error instanceof registry.RegistryError) {
    return res.status(error.status).json({ status: 'error', code: error.code, message: error.message });
  }
  if (error?.code === 11000) {
    return res.status(409).json({ status: 'error', code: 'HOST_ALREADY_CONFIGURED', message: 'This id or address is already registered' });
  }
  return res.status(500).json({ status: 'error', code: 'HOST_REGISTRY_FAILED', message: error.message });
}

router.get('/inference-hosts', async (req, res) => {
  try {
    return res.json({ status: 'success', data: { hosts: await registry.list() } });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/inference-hosts', async (req, res) => {
  try {
    return res.status(201).json({ status: 'success', data: await registry.create(req.body || {}) });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/inference-hosts/:hostId', async (req, res) => {
  try {
    return res.json({ status: 'success', data: await registry.update(req.params.hostId, req.body || {}) });
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/inference-hosts/:hostId', async (req, res) => {
  if (!requireTypedConfirmation(req, res, 'REMOVE HOST', req.params.hostId)) return undefined;
  try {
    return res.json({ status: 'success', data: await registry.remove(req.params.hostId) });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;

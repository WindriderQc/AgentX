'use strict';
const express = require('express');
const logger = require('../config/logger');
const hostPrefService = require('../src/services/hostPreferenceService');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');
const { requestPrincipal } = require('../src/helpers/requestCaller');
const { runRuntimeMutation } = require('../src/services/runtimeMutationLeaseService');
const { projectHostPreferenceForRead } = require('../src/services/hostPreferencePublicProjection');
const pinContextApply = require('../src/services/pinContextApplyService');

const PIN_REFUSALS = ['HOST_PIN_INVALID', 'HOST_PIN_CAPACITY', 'HOST_PIN_NOT_FOUND', 'HOST_PIN_CONFLICT',
  ...pinContextApply.CONTEXT_APPLY_REFUSALS];

module.exports = function createHostPinRouter(resolveHostPreferenceUrl) {
  const router = express.Router();

  // beforeWrite may refuse (no write yet) or prepare; afterVerified runs once
  // every resident verified and throws to trigger the same verified rollback.
  async function changePin(req, hostUrl, method, {
    restore = true, body = req.body, beforeWrite = null, afterVerified = null
  } = {}) {
    const outcome = await runRuntimeMutation({
      principal: requestPrincipal(req),
      scope: `host-pin:${method}:${hostUrl}`
    }, async ({ signal, assertActive }) => {
      const previous = await hostPrefService.getPinStatus(hostUrl);
      let prepared = null;
      let updated;
      try {
        if (beforeWrite) prepared = await beforeWrite(previous, { signal, assertActive });
        updated = await hostPrefService[method](hostUrl, body.model, body);
      } catch (error) {
        // These errors attest that a pre-check, validation or CAS refused the write.
        if (PIN_REFUSALS.includes(error.code)) {
          return { pinMutationError: error };
        }
        throw error;
      }
      if (!updated || !restore) return updated;
      try {
        const restored = await hostPrefService.restorePinnedModels(hostUrl, {
          signal, assertAuthorityActive: assertActive
        });
        if (restored?.verified !== true) {
          throw Object.assign(new Error(restored?.error || 'Pins were not verified together in VRAM'), {
            code: 'HOST_PIN_RESTORE_FAILED', statusCode: 409
          });
        }
        const result = { ...updated, status: restored.status, verification: restored.verification };
        if (afterVerified) Object.assign(result, await afterVerified({ restored, prepared }, { signal, assertActive }));
        return result;
      } catch (error) {
        // Do not issue another mutation when lease ownership/outcome is unknown.
        assertActive();
        if (signal.aborted || error.code === 'RUNTIME_MUTATION_OUTCOME_UNKNOWN') throw error;
        await hostPrefService.updatePreference(hostUrl, {
          pinnedModels: previous.pinnedModels,
          maxConcurrentModels: Math.max(previous.maxConcurrentModels || 1, previous.pinnedModels.length)
        });
        const rollback = await hostPrefService.restorePinnedModels(hostUrl, {
          signal, assertAuthorityActive: assertActive
        });
        error.message += rollback?.verified === true
          ? '; previous pins restored' : '; previous pin settings restored, runtime restoration unverified';
        error.rollback = rollback?.verified === true ? 'verified' : 'unverified';
        // A verified rollback is a terminal outcome. Complete the lease before
        // reporting the rejected pin to HTTP; only ambiguity must quarantine.
        if (rollback?.verified === true) return { pinMutationError: error };
        throw error;
      }
    });
    if (outcome?.pinMutationError) throw outcome.pinMutationError;
    return outcome;
  }

  for (const [verb, method] of [['post', 'addPinnedModel'], ['patch', 'updatePinnedModel']]) {
    router[verb]('/host-preferences/:hostUrl(*)/pin', async (req, res) => {
      try {
        const hostUrl = resolveHostPreferenceUrl(req, res);
        if (!hostUrl) return;
        if (!req.body?.model) return res.status(400).json({ status: 'error', message: 'model is required' });
        const data = await changePin(req, hostUrl, method);
        if (!data) return res.status(404).json({ status: 'error', message: 'Host preference not found' });
        res.json({ status: 'success', data: projectHostPreferenceForRead(data) });
      } catch (error) {
        res.status(error.statusCode || 500).json({ status: 'error', code: error.code || 'HOST_PIN_UPDATE_FAILED', message: error.message });
      }
    });
  }

  // Operator-confirmed Profiler proposal: change one pin's context allocation,
  // verify every resident in VRAM and the short-prompt speed, else roll back.
  router.post('/host-preferences/:hostUrl(*)/pin/context', async (req, res) => {
    try {
      const hostUrl = resolveHostPreferenceUrl(req, res);
      if (!hostUrl) return;
      const request = pinContextApply.validateContextApplyRequest(req.body || {});
      const hooks = pinContextApply.createContextApplyHooks(hostUrl, request, {
        loadPreference: url => hostPrefService.getByHost(url)
      });
      const data = await changePin(req, hostUrl, 'updatePinnedModel', {
        body: { model: request.model, contextSize: request.contextSize },
        ...hooks
      });
      if (!data) return res.status(404).json({ status: 'error', message: 'Host preference not found' });
      emitBuddyEvent('pin_context_applied', 'infrastructure',
        `Pinned ${request.model} at ${request.contextSize} context on ${data.displayName || hostUrl}`, 'normal');
      res.json({ status: 'success', data: { ...projectHostPreferenceForRead(data), contextApply: data.contextApply } });
    } catch (error) {
      logger.error('[NerveCenter] pin context apply failed', { error: error.message, code: error.code });
      res.status(error.statusCode || 500).json({
        status: 'error', code: error.code || 'HOST_PIN_CONTEXT_APPLY_FAILED', message: error.message,
        ...(error.rollback ? { rollback: error.rollback } : {}),
        ...(error.details ? { details: error.details } : {})
      });
    }
  });

  router.get('/host-preferences/:hostUrl(*)/pin', async (req, res) => {
    try {
      const hostUrl = resolveHostPreferenceUrl(req, res);
      if (!hostUrl) return;
      const data = await hostPrefService.getPinStatus(hostUrl);
      res.json({ status: 'success', data });
    } catch (err) {
      logger.error('[NerveCenter] pin status fetch failed', { error: err.message });
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  router.put('/host-preferences/:hostUrl(*)/pin', async (req, res) => {
    try {
      const hostUrl = resolveHostPreferenceUrl(req, res);
      if (!hostUrl) return;
      const { model } = req.body || {};
      if (!model) {
        return res.status(400).json({ status: 'error', message: 'model is required' });
      }
      const pref = await changePin(req, hostUrl, 'setPinnedModel');
      if (!pref) {
        return res.status(404).json({ status: 'error', message: 'Host preference not found. Configure the host first.' });
      }
      emitBuddyEvent('model_pinned', 'infrastructure', `Pinned ${model} on ${pref.displayName || hostUrl}`, 'normal');
      logger.info('[NerveCenter] Model pinned', { hostUrl, model });
      res.json({ status: 'success', data: { pinnedModels: pref.pinnedModels || [], status: pref.status } });
    } catch (err) {
      logger.error('[NerveCenter] pin set failed', { error: err.message });
      res.status(err.statusCode || 500).json({ status: 'error', code: err.code || 'HOST_PIN_SET_FAILED', message: err.message });
    }
  });

  router.delete('/host-preferences/:hostUrl(*)/pin', async (req, res) => {
    try {
      const hostUrl = resolveHostPreferenceUrl(req, res);
      if (!hostUrl) return;
      if (req.body?.model) {
        const data = await changePin(req, hostUrl, 'removePinnedModel', { restore: false });
        if (!data) return res.status(404).json({ status: 'error', message: 'Host preference not found' });
        return res.json({ status: 'success', data: projectHostPreferenceForRead(data) });
      }
      if (!requireTypedConfirmation(req, res, 'CLEAR HOST PIN', hostUrl)) return;
      const pref = await runRuntimeMutation({
        principal: requestPrincipal(req),
        scope: `host-pin:clear:${hostUrl}`
      }, () => hostPrefService.clearPinnedModel(hostUrl));
      if (!pref) {
        return res.status(404).json({ status: 'error', message: 'Host preference not found' });
      }
      emitBuddyEvent('model_unpinned', 'infrastructure', `Unpinned model on ${pref.displayName || hostUrl}`, 'normal');
      logger.info('[NerveCenter] Model unpinned', { hostUrl });
      res.json({ status: 'success', data: { pinnedModels: [], status: pref.status } });
    } catch (err) {
      logger.error('[NerveCenter] pin clear failed', { error: err.message });
      res.status(err.statusCode || 500).json({ status: 'error', code: err.code || 'HOST_PIN_CLEAR_FAILED', message: err.message });
    }
  });

  router.post('/host-preferences/:hostUrl(*)/restore', async (req, res) => {
    try {
      const hostUrl = resolveHostPreferenceUrl(req, res);
      if (!hostUrl) return;
      const result = await runRuntimeMutation({
        principal: requestPrincipal(req),
        scope: `host-pin:restore:${hostUrl}`
      }, ({ signal, assertActive }) => hostPrefService.restorePinnedModels(hostUrl, {
        signal,
        assertAuthorityActive: assertActive
      }));
      if (result.status === 'error') {
        return res.status(400).json({ status: 'error', message: result.error });
      }
      const primaryPin = result.pinnedModels?.[0] || null;
      emitBuddyEvent('model_restoring', 'infrastructure', `Restoring ${primaryPin} on ${hostUrl}`, 'normal');
      logger.info('[NerveCenter] Pin restore triggered', { hostUrl, pinnedModels: result.pinnedModels });
      res.json({ status: 'success', data: result });
    } catch (err) {
      logger.error('[NerveCenter] pin restore failed', { error: err.message });
      res.status(err.statusCode || 500).json({ status: 'error', code: err.code || 'HOST_PIN_RESTORE_FAILED', message: err.message });
    }
  });

  router.post('/host-preferences/:hostUrl(*)/swap', async (req, res) => {
    try {
      const hostUrl = resolveHostPreferenceUrl(req, res);
      if (!hostUrl) return;
      const { model } = req.body || {};
      if (!model) {
        return res.status(400).json({ status: 'error', message: 'model is required' });
      }
      const result = await runRuntimeMutation({
        principal: requestPrincipal(req),
        scope: `host-model:swap:${hostUrl}:${model}`
      }, ({ signal, assertActive }) => hostPrefService.swapModel(hostUrl, model, {
        signal,
        assertAuthorityActive: assertActive
      }));
      emitBuddyEvent('model_swapping', 'infrastructure', `Swapping to ${model} on ${hostUrl}`, 'normal');
      logger.info('[NerveCenter] Model swap triggered', { hostUrl, model });
      res.json({ status: 'success', data: result });
    } catch (err) {
      logger.error('[NerveCenter] model swap failed', { error: err.message });
      res.status(err.statusCode || 500).json({ status: 'error', code: err.code || 'HOST_MODEL_SWAP_FAILED', message: err.message });
    }
  });
  return router;
};

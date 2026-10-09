'use strict';

const mongoose = require('mongoose');
const HostPreference = require('../../models/HostPreference');
const { getPinnedEntries, pinNamesMatch, positiveInteger } = require('./hostPinPrimitives');

/**
 * CPU thread count a host pins for a model, or 0. Ollama reloads a runner
 * whose num_thread differs, so every request that touches a pinned model
 * (watchdog probe, post-benchmark restore) must send the pin's value; on a CPU
 * host that reload takes long enough to time out and quarantine the host.
 */
async function pinNumThread(hostUrl, model) {
  // Never wait on a disconnected database: Mongoose would buffer the query.
  if (!hostUrl || !model || mongoose.connection.readyState !== 1) return 0;
  try {
    const pref = await HostPreference.findOne({ hostUrl }).select('pinnedModels').maxTimeMS(1000).lean();
    const entry = getPinnedEntries(pref).find(item => pinNamesMatch(item.model, model));
    return positiveInteger(entry?.numThread) || 0;
  } catch {
    return 0;
  }
}

/**
 * Probe options for a resident model: its context and, on a CPU host, its
 * pinned thread count (GPU pins leave num_thread to Ollama).
 */
async function watchdogProbeOptions(hostUrl, model, contextLength) {
  const cpuHost = require('../helpers/hostResidency').hostResidency(hostUrl) === 'cpu';
  const numThread = model && cpuHost ? await pinNumThread(hostUrl, model) : 0;
  return {
    num_predict: 1,
    ...(model && Number.isSafeInteger(contextLength) && contextLength > 0 && { num_ctx: contextLength }),
    ...(numThread && { num_thread: numThread })
  };
}

module.exports = { pinNumThread, watchdogProbeOptions };

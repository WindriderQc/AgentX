'use strict';

/**
 * CPU threads for requests Benchmark sends straight to an Ollama host.
 *
 * On a CPU-resident host the pin of a model carries its thread count (Core's
 * host registry publishes it). A probe without it lets Ollama start its
 * default thread count: the model reloads, and on a service capped below the
 * machine's cores it is measured several times slower than it serves.
 */

const hostConfig = require('../helpers/ollamaHostConfig');

function withPinThreads(hostUrl, body) {
  if (!body || typeof body !== 'object' || !body.model || body.options?.num_thread != null) return body;
  // An unload request carries no generation options.
  if (body.keep_alive === 0 || body.keep_alive === '0') return body;
  const threads = typeof hostConfig.getHostPinThreads === 'function' ? hostConfig.getHostPinThreads(hostUrl, body.model) : 0;
  return threads ? { ...body, options: { ...(body.options || {}), num_thread: threads } } : body;
}

module.exports = { withPinThreads };

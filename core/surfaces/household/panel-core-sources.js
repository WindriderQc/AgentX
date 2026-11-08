'use strict';

const { serviceHealth, projectedJson, fleetSummary } = require('./panel-sources');

async function boundedRead(read, timeoutMs, unavailableMessage) {
  let timer, timedOut = false;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('deadline'));
        }, timeoutMs);
      })
    ]);
  } catch {
    // Match the public route's bounded disclosure, never a collector's private error.
    throw new Error(timedOut ? `Core read timed out after ${timeoutMs}ms` : unavailableMessage);
  } finally {
    clearTimeout(timer);
  }
}

function createPanelCoreSources({ CORE_SELF_URL, corePanelReads } = {}) {
  // Only the built-in Core composition supplies these readers. An explicit
  // destination (even loopback) retains HTTP, including its failure semantics.
  const nativeReader = name => !process.env.CORE_INTERNAL_URL && typeof corePanelReads?.[name] === 'function'
    ? corePanelReads[name] : null;

  async function health() {
    const read = nativeReader('health');
    if (!read) return serviceHealth('Core', `${CORE_SELF_URL()}/health`);
    const startedAt = Date.now();
    const row = { id: 'core', name: 'Core' };
    try {
      const body = await boundedRead(read, 5000, 'Core health is unavailable.');
      if (typeof body?.ok !== 'boolean') throw new Error('Core health is unavailable.');
      return { ...row, status: body.ok ? 'ok' : 'down', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { ...row, status: 'down', latencyMs: Date.now() - startedAt, error: error.message };
    }
  }

  async function ecosystem() {
    const read = nativeReader('ecosystem');
    if (!read) return projectedJson(`${CORE_SELF_URL()}/api/nerve-center/ecosystem`, fleetSummary, fleetSummary({}));
    const startedAt = Date.now();
    try {
      const body = await boundedRead(read, 8000, 'Ecosystem snapshot is unavailable.');
      return { ...fleetSummary(body), latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { ...fleetSummary({}), latencyMs: Date.now() - startedAt, error: error.message };
    }
  }

  return { health, ecosystem };
}

module.exports = { createPanelCoreSources };

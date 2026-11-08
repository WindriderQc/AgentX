'use strict';

const { cachedProjectedJson, cachedProjection } = require('./panel-sources');

const TIMEOUT_MS = 8000;

async function readNative(read, unavailableMessage) {
  let timer, timedOut = false;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('deadline'));
        }, TIMEOUT_MS);
      })
    ]);
  } catch {
    throw new Error(timedOut ? `Core read timed out after ${TIMEOUT_MS}ms` : unavailableMessage);
  } finally {
    clearTimeout(timer);
  }
}

function createBriefingCoreSources({ CORE_SELF_URL, coreBriefingReads } = {}) {
  function source(name, path, projector, unavailableMessage) {
    const keys = new WeakMap();
    return () => {
      const native = !process.env.CORE_INTERNAL_URL && typeof coreBriefingReads?.[name] === 'function'
        ? coreBriefingReads[name] : null;
      if (!native) return cachedProjectedJson(`${CORE_SELF_URL()}${path}`, projector, { unavailable: true }, TIMEOUT_MS);
      // Per-mount, per-domain keys include the actual reader identity and fixed
      // 24h read arguments. HTTP destinations never reuse native cache entries.
      let key = keys.get(native);
      if (!key) {
        key = Object.freeze({ reader: native, path, period: '24h' });
        keys.set(native, key);
      }
      return cachedProjection(key, () => readNative(async () => {
        const body = await native();
        const data = body?.data || body;
        const valid = name === 'morningBrief'
          ? body?.status === 'success' && data?.report === 'morning-brief' && data?.period === '24h'
          : data?.period === '24h' && Number.isFinite(data?.total_requests) && ['green', 'yellow', 'red'].includes(data?.budget_health);
        if (!valid) throw new Error('Native read returned no canonical body');
        return body;
      }, unavailableMessage), projector, { unavailable: true });
    };
  }
  return {
    morningBrief: source('morningBrief', '/api/reports/morning-brief', body => body, 'Morning brief is unavailable.'),
    budget: source('budget', '/api/budget/status', body => body?.data || body, 'Budget status unavailable')
  };
}

module.exports = { createBriefingCoreSources };

'use strict';

/**
 * Core's client for the optional Data service (DATAAPI_BASE_URL,
 * default the Compose-internal http://data:3083). Shared by the Data Toolbox
 * relay and Core capabilities that consume Data projections.
 */

const DEFAULT_DATA_URL = 'http://data:3083';

function dataBaseUrl(env = process.env) {
  const value = String(env.DATAAPI_BASE_URL || DEFAULT_DATA_URL).trim().replace(/\/+$/, '');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('DATAAPI_BASE_URL must be an http(s) URL without embedded credentials');
  }
  return url.toString().replace(/\/$/, '');
}

async function fetchData(relativePath, { query = '', timeoutMs = 10000, method = 'GET', payload } = {}) {
  const suffix = query ? `?${query}` : '';
  const url = `${dataBaseUrl()}${relativePath}${suffix}`;
  const headers = { Accept: 'application/json' };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error('Data service returned an unreadable response'); }
  if (!body || typeof body !== 'object') throw new Error('Data service returned an unreadable response');
  return { response, body };
}

/**
 * Open a Data response and hand its body over unread, for a file too large to
 * hold in memory. `headerTimeoutMs` bounds the wait for Data's first answer and
 * `totalTimeoutMs` the whole transfer. The caller reads `response.body` and
 * calls `close()` when it is done or gives up: that ends the upstream request.
 */
async function openDataStream(relativePath, { headerTimeoutMs = 10000, totalTimeoutMs = 15 * 60000 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const arm = (ms) => {
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
    timer.unref?.();
    return timer;
  };
  let timer = arm(headerTimeoutMs);
  try {
    const response = await fetch(`${dataBaseUrl()}${relativePath}`, { headers: { Accept: '*/*' }, signal: controller.signal });
    clearTimeout(timer);
    timer = arm(totalTimeoutMs);
    return { response, timedOut: () => timedOut, close: () => { clearTimeout(timer); controller.abort(); } };
  } catch (error) {
    clearTimeout(timer);
    if (!timedOut) throw error;
    const timeout = new Error('Data service request timed out');
    timeout.name = 'TimeoutError';
    throw timeout;
  }
}

module.exports = { DEFAULT_DATA_URL, dataBaseUrl, fetchData, openDataStream };

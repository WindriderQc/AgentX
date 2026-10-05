'use strict';

const fetch = require('node-fetch');

async function readRuntimeVersion(hostUrl, read = fetch, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await read(`${String(hostUrl).replace(/\/+$/, '')}/api/version`, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    return response.ok ? (await response.json()).version : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { readRuntimeVersion };

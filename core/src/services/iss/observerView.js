'use strict';

// An instance enables this only after its HTTPS viewer supports the browser-only
// fragment contract. Coordinates are rounded exactly as the Core calculation.
function observerView(observer, env = process.env) {
  try {
    const url = new URL(String(env.ISS_VIEW_URL || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const synchronized = env.ISS_VIEW_OBSERVER_MODE === 'fragment-v1';
    if (synchronized) {
      url.hash = `passages?observer=v1:${observer.lat.toFixed(2)},${observer.lon.toFixed(2)}`;
    }
    return { url: url.toString(), label: 'Vue 3D de l’ISS et des passages', observerSynchronized: synchronized };
  } catch { return null; }
}

module.exports = { observerView };

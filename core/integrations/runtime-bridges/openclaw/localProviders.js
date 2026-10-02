'use strict';

const OPENCLAW_ROUTE_SCOPE = '/api/openclaw-ollama';

// A provider is local when its requests go through Core's OpenClaw bridge,
// whatever its id: a conversation provider that only adds a header to the
// same route is as local as `ollama`.
function coreRoutedProviderIds(providers = {}, knownIds = ['ollama']) {
  const ids = new Set(knownIds.filter(Boolean));
  for (const [id, provider] of Object.entries(providers || {})) {
    try {
      const pathname = new URL(String(provider?.baseUrl || '')).pathname.replace(/\/+$/, '');
      if (pathname === OPENCLAW_ROUTE_SCOPE) ids.add(id);
    } catch {
      // A provider without an absolute baseUrl is not routed through Core.
    }
  }
  return ids;
}

function isLocalModel(model, providerIds = new Set(['ollama'])) {
  const value = String(model || '').trim();
  const slash = value.indexOf('/');
  return slash > 0 && providerIds.has(value.slice(0, slash));
}

module.exports = { OPENCLAW_ROUTE_SCOPE, coreRoutedProviderIds, isLocalModel };

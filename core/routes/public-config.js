'use strict';

/**
 * GET /api/config — public browser configuration: profile, public service
 * URLs and navigation. Without OLLAMA_HOST the navigation still resolves and
 * inference is reported unconfigured instead of failing the whole response.
 */

const { normalizeHostUrl } = require('../src/helpers/ollamaHostConfig');
const { isDemoProfile } = require('../../shared/agentxRuntimeProfile');
const { normalizeTrustedRuntimeNavItems } = require('../src/extensions/trustedRuntimeNavigation');

function describeOllama(value) {
  const fullUrl = normalizeHostUrl(value);
  if (!fullUrl) return null;
  const match = fullUrl.match(/^(?:https?:\/\/)?([^:]+)(?::(\d+))?/);
  return {
    host: match ? match[1] : 'localhost',
    port: match && match[2] ? match[2] : '11434',
    fullUrl
  };
}

function createPublicConfigHandler({ app, profile, env = process.env }) {
  return function publicConfig(_req, res) {
    const ollama = describeOllama(env.OLLAMA_HOST);
    res.json({
      profile,
      ollama,
      inference: ollama
        ? { configured: true }
        : { configured: false, reason: 'OLLAMA_HOST is not configured' },
      features: {},
      // Browser-reachable URLs for cross-service navigation. Public JS
      // and EJS pages use these instead of hardcoded localhost:<port>
      // so remote browsers reach the right host.
      publicUrls: app.locals.publicUrls,
      // Optional same-origin return path supplied by the composing host. It is
      // absent by default so standalone and shareable Product remain neutral.
      hostHome: app.locals.hostHome,
      // Validated launchers supplied by trusted extensions. Benchmark and RAG
      // read this projection so every Product service renders the same
      // "External runtimes" entries; the launcher hrefs are Core routes.
      navigation: {
        trustedRuntimeNavItems: isDemoProfile(profile)
          ? []
          : normalizeTrustedRuntimeNavItems(app.locals.trustedRuntimeNavItems)
      }
    });
  };
}

module.exports = { createPublicConfigHandler };

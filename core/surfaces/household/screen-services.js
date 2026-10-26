'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { screenDestinations } = require('../../../shared/screenDestinations');
const pages = require('../../public/js/screen-pages');
const { getPublicUrls } = require('../../../shared/browserPublicUrls');

// Private instance configuration, never a model-controlled discovery/fetch URL.
function loadServices(env, logger) {
  if (!env.AGENTX_INSTANCE_ROOT) return [];
  try {
    const file = path.join(env.AGENTX_INSTANCE_ROOT, 'config/screen-services.json');
    if (fs.statSync(file).size > 32768) throw new Error('Screen services file is too large');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.services) || data.services.length > 32) throw new Error('Invalid screen services schema');
    return data.services.map(value => {
      const row = pages.destination(value);
      if (!row || !/^https?:\/\//.test(row.href) || new URL(row.href).search) throw new Error('Invalid service destination');
      // Mixed-content HTTP cannot be framed from the private HTTPS entry.
      return { ...row, mode: row.mode === 'frame' && row.href.startsWith('https://') ? 'frame' : 'link' };
    });
  } catch (error) {
    if (error.code !== 'ENOENT') logger?.warn?.('Screen services unavailable: invalid instance configuration');
    return [];
  }
}

function createScreenServices({ app, env = process.env, logger, services = loadServices(env, logger) } = {}) {
  let signature, catalog;
  function current() {
    // Household registers before optional runtime bridges. Resolve their
    // validated launchers after bootstrap rather than freezing an empty list.
    const options = { publicUrls: app?.locals?.publicUrls || getPublicUrls(env),
      agentxProfile: app?.locals?.agentxProfile || 'full', trustedRuntimeNavItems: app?.locals?.trustedRuntimeNavItems || [] };
    const next = JSON.stringify(options);
    if (next !== signature) { catalog = pages.createCatalog([...screenDestinations(options), ...services]); signature = next; }
    return catalog;
  }
  return Object.freeze({
    get entries() { return current().entries; }, get PAGES() { return current().PAGES; },
    parse: value => current().parse(value), canonical: pages.canonical,
    url: (value, options) => current().url(value, options), label: value => current().label(value), mode: value => current().mode(value), keepsConversation: value => current().keepsConversation(value)
  });
}

const { allowScreenFrame } = require('../../../shared/screenView');

function screenPolicy(catalog) {
  const localPaths = new Set(catalog.entries.filter(row => row.mode === 'frame' && row.href.startsWith('/'))
    .map(row => new URL(row.href, 'https://agentx.invalid').pathname));
  const origins = [...new Set(catalog.entries.filter(row => row.mode === 'frame' && row.href.startsWith('https://'))
    .map(row => new URL(row.href).origin))];
  return (req, res, next) => {
    if (req.method === 'GET' && req.query.view === 'screen' && localPaths.has(req.path)) allowScreenFrame(res);
    if (req.method === 'GET' && ['/dad', '/voice', '/voix', '/voice.html'].includes(req.path) && origins.length) {
      const policy = res.getHeader('Content-Security-Policy');
      if (policy) res.setHeader('Content-Security-Policy', String(policy).replace(/(?:^|;)\s*frame-src [^;]*/g, '')
        + `; frame-src 'self' ${origins.join(' ')}`);
    }
    next();
  };
}
function requestsScreenVisit(text, catalog) {
  const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]/g, ' ');
  const input = fold(text);
  if (!/\b(?:ouvre|ouvrir|montre|montrer|affiche|afficher|visite|visiter|guide|guider|navigue|naviguer|emmene|amene|open|show|visit|guide|navigate|tour)\b/.test(input)) return false;
  if (catalog?.PAGES?.ecosystem && /\b(?:ecosysteme|ecosystem|ou (?:passent|vont|circulent) (?:les |mes )?donnees|data flows?)\b/.test(input)) return true;
  return /\b(?:pages?|sites?|services?|home\s?assistant|agentx|tableau de bord|dashboard)\b/.test(input)
    || (catalog?.entries || []).some(row => [fold(row.id), fold(row.label)].some(name => name.length > 2 && input.includes(name)));
}

function registerScreenServices({ app, router, env, logger, envelope }) {
  const catalog = createScreenServices({ app, env, logger });
  app.use(screenPolicy(catalog));
  router.get('/private/screen-pages', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    return envelope(res, { destinations: catalog.entries });
  });
  return catalog;
}

module.exports = { loadServices, createScreenServices, allowScreenFrame, screenPolicy, requestsScreenVisit, registerScreenServices };

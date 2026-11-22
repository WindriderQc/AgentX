'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { screenDestinations } = require('../../../shared/screenDestinations');
const pages = require('../../public/js/screen-pages');
const { getPublicUrls } = require('../../../shared/browserPublicUrls');
const { configuration, foldDeviceName } = require('../../src/services/homeAssistantPlug');
const { readHouseLayout } = require('./housex-layout');
const { readHouseEcosystem } = require('./housex-ecosystem');

const HOME_PANEL = 'home-assistant-panel';
const HOUSEX_ECOSYSTEM = 'housex-ecosystem';
const homeDevicePage = id => 'home-assistant-device-' + id;

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
      return { ...row, ...(value.family === true && { family: true }), mode: row.mode === 'frame' && row.href.startsWith('https://') ? 'frame' : 'link' };
    });
  } catch (error) {
    if (error.code !== 'ENOENT') logger?.warn?.('Screen services unavailable: invalid instance configuration');
    return [];
  }
}

function createScreenServices({ app, env = process.env, logger, services = loadServices(env, logger) } = {}) {
  const home = configuration(env);
  const infrastructure = home && readHouseLayout(env) && readHouseEcosystem(env);
  let signature, catalog;
  function current() {
    // Household registers before optional runtime bridges. Resolve their
    // validated launchers after bootstrap rather than freezing an empty list.
    const options = { publicUrls: app?.locals?.publicUrls || getPublicUrls(env),
      agentxProfile: app?.locals?.agentxProfile || 'full', trustedRuntimeNavItems: app?.locals?.trustedRuntimeNavItems || [] };
    const next = JSON.stringify(options);
    if (next !== signature) {
      const menu = screenDestinations(options);
      if (menu.some(row => row.id === 'kids')) menu.push({ id: 'kids-tasks', label: 'Tâches des enfants · lecture seule', href: '/kids', mode: 'frame' });
      if (home && options.agentxProfile !== 'demo') {
        menu.push({ id: HOME_PANEL, label: 'Home Assistant · Maison', href: '/dad/home-assistant', mode: 'frame' });
        if (infrastructure && menu.some(row => row.id === 'ecosystem')) {
          menu.push({ id: HOUSEX_ECOSYSTEM, label: 'HouseX · Écosystème', href: '/dad/home-assistant?layer=ecosystem', mode: 'frame' });
        }
        for (const plug of home.additionalPlugs) {
          menu.push({ id: homeDevicePage(plug.id), label: plug.label, href: '/dad/home-assistant?device=' + plug.id, mode: 'frame' });
        }
      }
      catalog = pages.createCatalog([...menu, ...services]);
      signature = next;
    }
    return catalog;
  }
  return Object.freeze({
    get family() { return pages.createCatalog([...current().entries.filter(row => ['ecosystem', 'kids-tasks'].includes(row.id)),
      ...services.filter(row => row.family === true && ['earth', 'iss'].includes(row.id))]); },
    get entries() { return current().entries; }, get PAGES() { return current().PAGES; },
    parse: value => current().parse(value), canonical: pages.canonical,
    automaticPage: text => automaticPage(text, current(), home),
    homeAssistantDeviceForText: text => {
      const matches = mentionedPlugs(foldDeviceName(text), home);
      return matches.length === 1 ? matches[0].id : undefined;
    },
    url: (value, options) => current().url(value, options), label: value => current().label(value), mode: value => current().mode(value), keepsConversation: value => current().keepsConversation(value)
  });
}

const containsName = (input, name) => (' ' + input + ' ').includes(' ' + name + ' ');
const mentionedPlugs = (input, home) => home?.additionalPlugs.filter(plug => plug.aliases.some(name => containsName(input, name))) || [];

function directPage(input, catalog) {
  const name = /^(?:montre(?: moi)?|ouvre|affiche(?: moi)?|peux tu me (?:montrer|ouvrir|afficher)|show(?: me)?|open) (?:l |le |la |the )?(ecosysteme?|maison|house\s*x)(?: s il te plait| svp| stp| please)?$/.exec(input)?.[1];
  if (!name) return undefined;
  const page = /^ecosystem/.test(name) ? 'ecosystem' : HOME_PANEL;
  return catalog?.PAGES?.[page] ? page : undefined;
}

function homeAssistantPageFor(input, catalog, home) {
  if (!catalog.PAGES[HOME_PANEL]) return undefined;
  if (/\b(?:n ouvre pas|n affiche pas|ne montre pas|sans (?:ouvrir|afficher|montrer)|don t (?:open|show|display)|without (?:opening|showing|displaying))\b/.test(input)) return undefined;
  if (catalog.PAGES[HOUSEX_ECOSYSTEM] && /\bhouse\s*x\b/.test(input) && /\becosysteme?\b/.test(input)) return HOUSEX_ECOSYSTEM;
  const plugs = mentionedPlugs(input, home);
  if (plugs.length === 1) return homeDevicePage(plugs[0].id);
  if (plugs.length > 1) return HOME_PANEL;
  if (/\b(?:home\s*ass(?:ist|it)ant|workshop (?:smart )?plug|prise (?:intelligente |connectee )?(?:(?:de l|d|du|a l) )?atelier|garage camera|camera (?:du )?garage)\b/.test(input)
      || home.aliases.some(name => containsName(input, name))) return HOME_PANEL;
  return undefined;
}

function automaticPage(text, catalog, home) {
  const input = foldDeviceName(text);
  const direct = directPage(input, catalog);
  if (direct) return { page: direct, force: true };
  const homePage = homeAssistantPageFor(input, catalog, home);
  return homePage ? { page: homePage, force: homePage !== HOME_PANEL } : undefined;
}

const { allowScreenFrame } = require('../../../shared/screenView');

function screenPolicy(catalog) {
  const localPaths = new Set(catalog.entries.filter(row => row.mode === 'frame' && row.href.startsWith('/'))
    .map(row => new URL(row.href, 'https://agentx.invalid').pathname));
  const origins = [...new Set(catalog.entries.filter(row => row.mode === 'frame' && row.href.startsWith('https://'))
    .map(row => new URL(row.href).origin))];
  const familyOrigins = [...new Set((catalog.family?.entries || []).filter(row => row.mode === 'frame' && row.href.startsWith('https://')).map(row => new URL(row.href).origin))];
  return (req, res, next) => {
    if (req.method === 'GET' && req.query.view === 'screen' && localPaths.has(req.path)) allowScreenFrame(res);
    const allowedOrigins = req.path === '/panel' ? familyOrigins : origins;
    if (req.method === 'GET' && ['/dad', '/voice', '/voix', '/voice.html', '/panel'].includes(req.path) && allowedOrigins.length) {
      const policy = res.getHeader('Content-Security-Policy');
      if (policy) res.setHeader('Content-Security-Policy', String(policy).replace(/(?:^|;)\s*frame-src [^;]*/g, '')
        + `; frame-src 'self' ${allowedOrigins.join(' ')}`);
    }
    next();
  };
}
function requestsScreenVisit(text, catalog) {
  if (directPage(foldDeviceName(text), catalog)) return true;
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
  router.get('/family/screen-pages', (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    return envelope(res, { destinations: catalog.family.entries });
  });
  return catalog;
}

module.exports = { loadServices, createScreenServices, allowScreenFrame, screenPolicy, requestsScreenVisit, registerScreenServices };

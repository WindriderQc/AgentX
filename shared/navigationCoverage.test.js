'use strict';

// Every page a service serves is reachable from a menu or a link, and no menu
// entry points at a page nobody serves. Pages are read from the route sources,
// so a new page fails here until it is linked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildProductNavigation } = require('./productNavigation');
const { demoSurfaceDisabled } = require('./agentxRuntimeProfile');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const ORIGINS = { core: 'https://core.test', benchmark: 'https://benchmark.test', rag: 'https://rag.test' };
const SERVICE_BY_ORIGIN = Object.fromEntries(Object.entries(ORIGINS).map(([service, origin]) => [origin, service]));
const ROUTE_SOURCES = {
  core: ['core/src', 'core/routes', 'core/surfaces', 'core/integrations'],
  benchmark: ['benchmark/server.js', 'benchmark/src', 'benchmark/routes'],
  rag: ['rag/app.js', 'rag/src', 'rag/routes']
};
const HOUSEHOLD_PUBLIC = 'core/surfaces/household/public';

// A second address for a page that has its own entry: old bookmarks keep working.
const ALIASES = {
  core: {
    '/ecosystem': '/', '/portal': '/',
    '/dad/nestor': '/dad', '/voice': '/dad', '/voix': '/dad', '/voice.html': '/dad',
    '/voice-personas': '/dad/memories', '/voice-personas.html': '/dad/memories',
    '/lecture/parents': '/dad/family', '/lecture/parents.html': '/dad/family',
    '/unlock': '/dad', '/access/code': '/dad', '/access/face': '/dad'
  }
};
// Pages entered from another page rather than a menu: [file holding the link, the link].
const CONTEXTUAL = {
  benchmark: {
    '/setup': ['benchmark/public/js/benchmark-v2/experience.js', "'/setup'"]
  }
};

const SKIPPED_DIRS = new Set(['node_modules', 'public', 'test', 'tests', 'eval', 'fixtures']);
const NOT_A_PAGE = /^\/(?:api|assets|vendor|public|access-assets|psyx\/assets|healthz?|readyz|favicon|mcp)(?:[/.]|$)/;

function sourceFiles(entry) {
  const absolute = path.join(root, entry);
  if (!fs.statSync(absolute).isDirectory()) return [entry];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((child) => {
    if (child.isDirectory()) return SKIPPED_DIRS.has(child.name) ? [] : sourceFiles(`${entry}/${child.name}`);
    return child.name.endsWith('.js') && !child.name.endsWith('.test.js') ? [`${entry}/${child.name}`] : [];
  });
}

const normalize = (pathname) => pathname.replace(/\/+$/, '') || '/';

function servedPages(service) {
  const pages = new Set();
  for (const file of ROUTE_SOURCES[service].flatMap(sourceFiles)) {
    for (const call of read(file).matchAll(/\bapp\.get\(\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/g)) {
      for (const [, route] of call[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
        const asset = /\.(?!html$)[a-z0-9]+$/i.test(route);
        if (route.startsWith('/') && !/[:*$]/.test(route) && !asset && !NOT_A_PAGE.test(route)) pages.add(normalize(route));
      }
    }
  }
  return pages;
}

function addLink(links, href) {
  const url = new URL(href, ORIGINS.core);
  const service = SERVICE_BY_ORIGIN[url.origin];
  if (service && !NOT_A_PAGE.test(url.pathname)) links[service].add(normalize(url.pathname));
}

function productLinks(agentxProfile = 'full') {
  const links = { core: new Set(), benchmark: new Set(), rag: new Set() };
  const { navItems, brandHref } = buildProductNavigation({ service: 'core', publicUrls: ORIGINS, agentxProfile });
  addLink(links, brandHref);
  for (const item of navItems.flatMap((entry) => entry.children || [entry])) if (item.href) addLink(links, item.href);
  return links;
}

function householdLinks() {
  const links = { core: new Set(), benchmark: new Set(), rag: new Set() };
  const patterns = [
    /<a\b[^>]*?\shref=\\?["'](\/[^"'\\]*)/g, // anchors, in markup and in rendered templates
    /\bhref:\s*'(\/[^']*)'/g,                 // home directory entries
    /\[\s*'(\/[^']*)'\s*,\s*'[^']+'\s*\]/g    // section navigation pairs
  ];
  for (const name of fs.readdirSync(path.join(root, HOUSEHOLD_PUBLIC))) {
    if (!/\.(?:html|js)$/.test(name)) continue;
    const text = read(`${HOUSEHOLD_PUBLIC}/${name}`);
    for (const pattern of patterns) for (const [, href] of text.matchAll(pattern)) addLink(links, href);
  }
  return links;
}

function contextualLinks(service) {
  const pages = new Set();
  for (const [page, [file, needle]] of Object.entries(CONTEXTUAL[service] || {})) {
    assert.ok(read(file).includes(needle), `${file} no longer links ${page}`);
    pages.add(page);
  }
  return pages;
}

test('every served page is reachable from a menu or a link', () => {
  const product = productLinks();
  const household = householdLinks();
  for (const service of Object.keys(ROUTE_SOURCES)) {
    const reachable = new Set([...product[service], ...household[service], ...contextualLinks(service)]);
    const aliases = ALIASES[service] || {};
    const unreachable = [...servedPages(service)].filter((page) => !reachable.has(page) && !reachable.has(aliases[page]));
    assert.deepEqual(unreachable, [], `${service} serves pages nothing links to. Add them to shared/productNavigation.js or to the Household shell.`);
  }
});

test('every menu entry leads to a served page', () => {
  const product = productLinks();
  const household = householdLinks();
  for (const service of Object.keys(ROUTE_SOURCES)) {
    const served = servedPages(service);
    const dead = [...new Set([...product[service], ...household[service]])].filter((page) => !served.has(page));
    assert.deepEqual(dead, [], `${service} menus link pages it does not serve.`);
  }
});

test('aliases and contextual entries name pages that are still served', () => {
  for (const service of Object.keys(ROUTE_SOURCES)) {
    const served = servedPages(service);
    const declared = [...Object.keys(ALIASES[service] || {}), ...Object.keys(CONTEXTUAL[service] || {})];
    assert.deepEqual(declared.filter((page) => !served.has(page)), [], `${service} declares pages it no longer serves.`);
  }
});

test('the demo navigation offers no full-profile destination', () => {
  const demo = productLinks('demo');
  assert.deepEqual([...demo.core].filter((page) => demoSurfaceDisabled(page)), []);
  assert.ok(!buildProductNavigation({ agentxProfile: 'demo', publicUrls: ORIGINS }).navItems.some((item) => item.id === 'personal-group'));
  assert.ok(buildProductNavigation({ agentxProfile: 'full', publicUrls: ORIGINS }).navItems.some((item) => item.id === 'personal-group'));
});

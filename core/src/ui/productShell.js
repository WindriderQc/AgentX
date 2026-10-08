'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const ejs = require('ejs');
const { buildProductNavigation } = require('../../../shared/productNavigation');
const { normalizeTrustedRuntimeNavItems } = require('../extensions/trustedRuntimeNavigation');

const views = path.resolve(__dirname, '../../views');
function navigationLocals(app, res, extra = {}) {
  return { ...app.locals, ...res.locals, buildProductNavigation, service: 'core', activePage: '',
    trustedRuntimeNavItems: app.locals.agentxProfile === 'demo' ? []
      : normalizeTrustedRuntimeNavItems(app.locals.trustedRuntimeNavItems), ...extra };
}

function registerProductHome(app) {
  app.get(['/', '/portal', '/ecosystem'], (_req, res) => res.render('layouts/main', {
    ...navigationLocals(app, res), pageView: '../pages/home', title: 'AgentX · Accueil',
    activePage: 'portal', bodyClass: 'product-home', pageLanguage: app.locals.agentxProfile === 'demo' ? 'en' : 'fr',
    headCss: '<link rel="stylesheet" href="/css/home.css">',
    footerJs: '<script src="/js/home.js" defer></script>'
  }));
}

// Static surfaces use the same EJS navigation as Core, Benchmark and RAG.
// No public configuration API or client-side catalogue is needed.
function surfacePage(app, file, { activePage, householdControls = false } = {}) {
  return async (_req, res, next) => {
    try {
      const [source, nav, icons] = await Promise.all([
        fs.readFile(file, 'utf8'),
        ejs.renderFile(path.join(views, 'partials/nav.ejs'), navigationLocals(app, res, { activePage, householdControls })),
        ejs.renderFile(path.join(views, 'partials/app-icons.ejs'))
      ]);
      const assets = icons + '<link rel="stylesheet" href="/css/local-fonts.css">'
        + '<link rel="stylesheet" href="/vendor/fontawesome/6.4.0/css/all.min.css">'
        + '<link rel="stylesheet" href="/css/product-shell.css">';
      res.type('html').send(source.replace('<!-- product-navigation -->', nav).replace('</head>', assets + '</head>'));
    } catch (error) { next(error); }
  };
}

function householdPage(app, file) {
  const names = { '/voice-personas/debug': 'voice-personas-debug',
    '/device-check': 'device-check', '/lecture/parents': 'dad-family', '/lecture/parents.html': 'dad-family',
    '/voice': 'dad', '/voice.html': 'dad', '/voix': 'dad',
    '/voice-personas': 'dad-memories', '/voice-personas.html': 'dad-memories' };
  return (req, res, next) => {
    const pathname = req.path.replace(/\/+$/, '') || '/';
    return surfacePage(app, file, { householdControls: true,
      activePage: names[pathname] || pathname.slice(1).replaceAll('/', '-') })(req, res, next);
  };
}

module.exports = { registerProductHome, surfacePage, householdPage };

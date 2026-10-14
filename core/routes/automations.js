'use strict';
const express = require('express');
const {createAutomationsService} = require('../src/services/automationsService');
function createRouter(service) {
  const router = express.Router();
  const handle = action => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {res.json({status: 'success', data: await action(req)});}
    catch (error) {res.status(error.status === 400 ? 400 : 503).json({status: 'error', error: {
      code: error.status === 400 ? 'INVALID_CALENDAR' : 'AUTOMATIONS_UNAVAILABLE',
      message: error.status === 400 ? 'Invalid calendar date or time zone.' : 'The automation inventory is unavailable.'}});}
  };
  router.get('/', handle(req => service.status({offset: Number(req.query.offset || 0), refresh: req.query.refresh === '1'})));
  router.get('/calendar', handle(req => service.calendar({date: req.query.date, timezone: req.query.timezone})));
  return router;
}
const resourceScripts = ['date', 'upcoming', 'headline', '', 'attention', 'actual', 'services', 'queue', 'controls']
  .map(name => `<script src="/js/cluster-schedule${name ? `-${name}` : ''}.js" defer></script>`).join('\n');
function mount(app, operations, service = createAutomationsService({operations})) {
  app.use('/api/automations', createRouter(service));
  app.get('/automations', (req, res) => {
    const resources = req.query.view === 'resources';
    res.render('layouts/main', {
      pageView: resources ? '../pages/cluster-schedule' : '../pages/operations-jobs',
      pageLanguage: 'fr', title: 'AgentX · Automatisations', service: 'core', activePage: 'automations',
      headCss: '<link rel="stylesheet" href="/css/operations-jobs.css">\n<link rel="stylesheet" href="/css/automations-hub.css">' +
        (resources ? '\n<link rel="stylesheet" href="/styles.css">\n<link rel="stylesheet" href="/css/cluster-schedule-layout.css">\n<link rel="stylesheet" href="/css/cluster-schedule-components.css">' : ''),
      footerJs: resources ? resourceScripts : '<script src="/js/automations-hub.js" defer></script>\n<script src="/js/operations-jobs.js" defer></script>'
    });
  });
  return service;
}
module.exports = {mount, createRouter};

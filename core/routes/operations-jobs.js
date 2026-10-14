'use strict';
const express = require('express');
const {createOperationsService} = require('../src/services/operationsJobsService');
function createRouter(service) {
  const router = express.Router();
  const json = express.json({limit: '4kb'});
  const handle = handler => async (req, res) => {
    try {res.json({status: 'success', data: await handler(req)});}
    catch (error) {res.status(error.status || 503).json({status: 'error', error: {code: error.code || 'OPERATIONS_UNAVAILABLE', message: error.message || 'Operations are unavailable.'}});}
  };
  router.get('/', handle(req => service.status({offset: Number(req.query.offset || 0), refresh: req.query.refresh === '1'})));
  router.patch('/:id', json, handle(req => service.patch(req.params.id, req.body)));
  router.post('/:id/run', json, handle(req => service.run(req.params.id, req.body)));
  router.post('/runs/:requestId/reconcile', json, handle(req => service.reconcile(req.params.requestId)));
  return router;
}
function mount(app, options = {}) {
  const service = options.service || createOperationsService();
  app.use('/api/operations/jobs', createRouter(service));
  app.get('/operations-jobs', (req, res) => res.render('layouts/main', {
    pageView: '../pages/operations-jobs', pageLanguage: 'fr', title: 'AgentX · Automatisations', service: 'core', activePage: 'operations-jobs',
    headCss: '<link rel="stylesheet" href="/css/operations-jobs.css">',
    footerJs: '<script src="/js/operations-jobs.js" defer></script>'
  }));
  service.startObserver();
  return service;
}
module.exports = {createRouter, mount};

'use strict';

// Personal finance ledger (read-only questions + inbox trigger). Gateway
// traffic uses the private LAN; the OpenClaw finance persona keeps its
// native permissions and reaches it over loopback.

const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const query = require('../src/services/finance/financeQueryService');
const { financeInbox } = require('../src/services/finance/financeInboxService');
const categories = require('../src/services/finance/financeCategories');
const analysis = require('../src/services/finance/financeInsights');
const { exportCsv } = require('../src/services/finance/financeExport');
const alerts = require('../src/services/finance/financeAlerts');
const { suggest } = require('../src/services/finance/financeSuggestions');
const plan = require('../src/services/finance/financePlan');
const simulation = require('../src/services/finance/financeSimulation');

function sendError(res, error) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500) console.error('[finance]', error);
  return res.status(status).json({
    status: 'error',
    code: error.code || 'FINANCE_ERROR',
    message: status >= 500 ? 'Finance request failed' : error.message
  });
}

function createFinanceRoutes({ inbox = financeInbox } = {}) {
  const router = express.Router();
  const handle = (fn) => async (req, res) => {
    try {
      return res.json({ status: 'success', data: await fn(req) });
    } catch (error) {
      return sendError(res, error);
    }
  };

  router.get('/statements', handle((req) => query.statements(req.query)));
  router.get('/balances', handle((req) => query.balances(req.query)));
  router.get('/transactions', handle((req) => query.transactions(req.query)));
  router.get('/summary/monthly', handle((req) => query.monthly(req.query)));
  router.get('/summary/merchants', handle((req) => query.merchants(req.query)));
  router.get('/summary/categories', handle((req) => query.byCategory(req.query)));
  router.get('/coverage', handle((req) => query.coverage(req.query)));
  router.get('/tags', handle((req) => query.tags(req.query)));
  router.get('/plan', handle(() => plan.getPlan()));
  router.put('/plan', handle((req) => plan.savePlan(req.body || {})));
  router.put('/plan/:section', handle((req) => plan.saveSection(req.params.section, req.body?.value)));
  router.post('/plan/ops', handle((req) => plan.applyOps(req.body?.ops ?? req.body)));
  router.get('/situation', handle((req) => plan.situation(req.query)));
  router.get('/simulate/debt', handle((req) => simulation.debtTrajectory(req.query)));
  router.post('/simulate/forecast', handle((req) => simulation.forecast(req.body || {})));
  router.get('/history/balances', handle((req) => simulation.balanceHistory(req.query)));
  router.get('/summary/category-months', handle((req) => simulation.categoryMonths(req.query)));
  router.get('/summary/yearly', handle((req) => analysis.yearly(req.query)));
  router.get('/insights', handle((req) => analysis.insights(req.query)));
  router.get('/alerts', handle((req) => (req.query.all === 'true' ? alerts.list({ includeAcknowledged: true }) : alerts.refresh())));
  router.post('/alerts/report', handle(() => alerts.report()));
  router.post('/alerts/ack', handle((req) => alerts.acknowledge(req.body?.ids)));
  router.get('/export.csv', async (req, res) => {
    let exported;
    try {
      exported = await exportCsv(req.query);
    } catch (error) {
      return sendError(res, error);
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${exported.fileName}"`);
    // Headers are sent: a failure now cuts the download before its totals.
    return pipeline(Readable.from(exported.chunks), res)
      .catch((error) => console.error('[finance] CSV export interrupted', error));
  });
  router.get('/uncategorized', handle((req) => categories.uncategorized(req.query)));
  router.post('/suggestions', handle((req) => suggest(req.body || {})));
  router.get('/rules', handle(() => categories.listRules()));
  router.post('/rules', handle((req) => categories.saveRules(req.body?.rules ?? req.body,
    { createdBy: String(req.body?.createdBy || 'owner').slice(0, 40) })));
  router.delete('/rules/:id', handle((req) => categories.deleteRule(req.params.id)));
  router.post('/transactions/decisions', handle((req) => categories.setTransactions(req.body?.transactions ?? req.body,
    { createdBy: String(req.body?.createdBy || 'owner').slice(0, 40) })));
  router.get('/inbox', handle(() => inbox().status()));

  // Ingestion can take minutes per statement; the scan runs in the background
  // and its results appear on GET /inbox.
  router.post('/inbox/scan', (req, res) => {
    const target = inbox();
    if (!target.settings.enabled) {
      return sendError(res, Object.assign(new Error('Finance inbox is not configured'), { code: 'FINANCE_INBOX_DISABLED', status: 409 }));
    }
    if (target.status().running) return res.status(409).json({ status: 'error', code: 'FINANCE_SCAN_RUNNING', message: 'A scan is already running' });
    target.scanOnce().catch((error) => console.error('[finance] inbox scan failed:', error.message));
    return res.status(202).json({ status: 'success', data: { started: true } });
  });

  return router;
}

// The Finance page reads the same API from the browser.
function renderFinancePage(_req, res) {
  res.render('layouts/main', {
    pageView: '../pages/finance',
    title: 'AgentX · Finances',
    service: 'core',
    activePage: 'finance',
    headCss: '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/css/finance.css?v=11">',
    footerJs: '<script src="/vendor/chart.js/4.5.1/chart.umd.js"></script><script src="/js/finance-situation.js?v=8" defer></script><script src="/js/finance-simulations.js?v=8" defer></script><script src="/js/finance-plan-editor.js?v=1" defer></script><script src="/js/finance.js?v=9" defer></script>'
  });
}

function mount(app, jsonParser) {
  app.use('/api/finance', jsonParser, createFinanceRoutes());
  app.get('/finance', renderFinancePage);
}

module.exports = createFinanceRoutes;
module.exports.mount = mount;

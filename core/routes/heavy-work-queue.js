'use strict';

const express = require('express');
const queue = require('../src/services/heavyWorkQueueService');
const evidence = require('../src/services/heavyWorkQueueEvidence');
const { getHeavyQueue } = require('../src/services/heavyQueueProjectionService');
const { requestPrincipal } = require('../src/helpers/requestCaller');
require('../src/services/heavyWorkQueueMonitor').start();

const router = express.Router();
const wrap = fn => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json({ ok: true, data: await fn(req) }); }
  catch (error) {
    res.status(error.statusCode || 503).json({ ok: false, code: error.code || 'HEAVY_QUEUE_UNAVAILABLE',
      message: error.statusCode ? error.message : 'Heavy-work queue unavailable; read the same request before retrying',
      ...(error.details && { details: error.details }) });
  }
};
// Same private-LAN human access and native caller attribution as other Core
// operations. Attribution is not authentication. No new account/code mechanism.
const actor = req => String(req.get('x-service-caller') || requestPrincipal(req)).slice(0, 100);
router.get('/', wrap(async () => {
  const current = await queue.list();
  if (current) return current;
  const legacy = await queue.legacySnapshot();
  return legacy ? { ...await getHeavyQueue(), migrationRequired: true, sha256: legacy.sha256 }
    : { available: true, authority: 'core.heavy-work-queue', scope: 'planned-heavy-work', jobs: [], count: 0 };
}));
router.post('/', wrap(req => queue.submit(req.body, actor(req))));
router.post('/migrate', wrap(req => queue.migrate(req.body, actor(req))));
router.get('/archive', wrap(req => queue.archived(Number(req.query.offset || 0), Number(req.query.limit || 50))));
router.post('/archive', wrap(req => queue.archive(actor(req))));
router.get('/export', async (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const state = await queue.list();
    if (!state) return res.status(409).json({ ok: false, message: 'Core queue is not active; preserve the legacy source' });
    const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    const markdown = ['# Heavy work queue — Core export', '', 'This is a snapshot, not a planning authority or runtime lease.', '',
      '| ID | State | Priority | Work | Hosts | Estimated start | Estimated end |', '|---|---|---|---|---|---|---|',
      ...state.jobs.map(job => `| ${[job.id, job.state, job.priority, job.title, job.hosts.join(', '), job.reservation?.start, job.reservation?.end].map(cell).join(' | ')} |`),
      '', `Archived requests: ${state.archivedCount}. Read them through /archive; their identities and receipts remain in Core.`, '',
      ...state.jobs.flatMap(job => [`## ${job.id}`, '', '```json', JSON.stringify(job, null, 2), '```', ''])].join('\n');
    res.type('text/markdown').set('Content-Disposition', 'attachment; filename="QUEUE.md"').send(markdown);
  } catch { res.status(503).json({ ok: false, message: 'Queue export unavailable' }); }
});
router.get('/:id', wrap(req => queue.get(req.params.id)));
router.post('/:id/reserve', wrap(req => queue.reserve(req.params.id, req.body, actor(req))));
router.post('/:id/begin', wrap(async req => {
  await evidence.preDispatch(await queue.get(req.params.id));
  return queue.begin(req.params.id, req.body, actor(req));
}));
router.post('/:id/record', wrap(req => queue.record(req.params.id, req.body, actor(req))));
router.post('/:id/prepared', wrap(req => queue.prepared(req.params.id, req.body, actor(req))));
router.post('/:id/assert-dispatch', wrap(req => queue.assertDispatch(req.params.id, req.body.dispatchId)));
router.post('/:id/cancel', wrap(req => queue.cancel(req.params.id, req.body, actor(req))));
router.post('/:id/reconcile', wrap(req => evidence.reconcile(req.params.id, actor(req))));
router.post('/:id/recover', wrap(req => queue.recover(req.params.id, req.body, actor(req))));

module.exports = router;

'use strict';
const queue = require('./heavyWorkQueueService');
const notifications = require('./heavyWorkQueueNotifications');
const { fail } = require('./heavyWorkQueueContract');
const view = job => ({ authority: 'core.heavy-work-queue', ...Object.fromEntries(['id', 'key', 'title', 'kind', 'state', 'revision', 'hosts', 'estimatedMinutes',
  'notBefore', 'startBefore', 'reservation', 'source', 'operation', 'releaseReceipt', 'reason', 'createdAt', 'updatedAt', 'archived']
  .filter(key => job[key] !== undefined).map(key => [key, job[key]])) });
async function operate(body, actor = 'nestor') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Work queue operation required');
  const fields = {
    list: ['offset', 'limit'], show: ['id'], request: ['request'], cancel: ['id', 'expectedRevision'],
    notifications: ['offset', 'limit'], acknowledge: ['id']
  };
  if (!Object.hasOwn(fields, body.action) || Object.keys(body).some(key => key !== 'action' && !fields[body.action].includes(key))) throw fail('Unsupported Nestor work queue operation or fields');
  if (body.action === 'notifications') {
    // On-demand observation publishes durable existing outcomes, never dispatches.
    await notifications.publishJobs((await queue.list())?.jobs || []);
    return notifications.inbox(body);
  }
  if (body.action === 'acknowledge') return notifications.acknowledge(body.id, actor);
  if (body.action === 'show') return view(await queue.get(body.id));
  if (body.action === 'cancel') return view(await queue.cancel(body.id, body, actor));
  if (body.action === 'request') {
    if (body.request?.executor || body.request?.source?.type !== 'nestor') throw fail('Nestor submits planning requests only, attributed to its native session');
    return view(await queue.submit(body.request, actor));
  }
  const offset = body.offset ?? 0, limit = body.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('Queue offset/limit invalid');
  const state = await queue.list();
  if (!state) throw fail('Core queue is not active; migration required', 409);
  const counts = state.jobs.reduce((result, job) => ({ ...result, [job.state]: (result[job.state] || 0) + 1 }), {});
  return { authority: state.authority, counts, count: state.count, archivedCount: state.archivedCount,
    offset, limit, jobs: state.jobs.slice(offset, offset + limit).map(view), observedAt: state.observedAt };
}
module.exports = { operate, view };

'use strict';
const queue = require('./heavyWorkQueueService');
const notifications = require('./heavyWorkQueueNotifications');
const { fail } = require('./heavyWorkQueueContract');
const readModel = require('./heavyWorkQueueReadModel');
const { workQueueExample } = require('../../../shared/workQueueExample.cjs');
const view = (job, options) => ({ authority: 'core.heavy-work-queue', presentation: readModel.presentation(job, options), ...Object.fromEntries(['id', 'key', 'title', 'kind', 'state', 'revision', 'hosts', 'estimatedMinutes',
  'notBefore', 'startBefore', 'reservation', 'source', 'operation', 'releaseReceipt', 'reason', 'createdAt', 'updatedAt', 'archived']
  .filter(key => job[key] !== undefined).map(key => [key, job[key]])) });

function overview({ summary, jobs }) {
  const { counts, reservations } = summary;
  const lines = [
    `Au registre ${summary.total} · Actifs ${summary.active} · Terminés ${counts.finished}.`,
    `File automatique ${counts.automatic_queue} · En attente d’action ${counts.action_required}.`,
    `Départs enregistrés ${counts.dispatching} · Exécutions enregistrées ${counts.running} · Incertains ${counts.uncertain} · Inconnus ${counts.unknown}.`,
    `Créneaux réservés ${reservations.total} · À venir ${reservations.upcoming} · Ouverts ${reservations.open} · Expirés ${reservations.expired} · Invalides ${reservations.invalid}.`,
    'Le démarrage automatique reste soumis à la fenêtre autorisée et à l’admission native.'
  ];

  if (counts.dispatching > 0) {
    lines.push('Chaque départ enregistré attend la confirmation d’exécution de l’exécuteur natif. Son mode de départ se vérifie sur la demande correspondante.');
  }

  const groups = new Map();
  for (const job of jobs) {
    const { phase, startMode, schedule, nextAction } = job.presentation;
    if (phase !== 'automatic_queue' && phase !== 'action_required') continue;
    const reserved = job.state === 'reserved';
    const key = [phase, startMode, reserved, schedule.state, nextAction.code, nextAction.actor].join('/');
    const group = groups.get(key);
    if (group) group.requestCount += 1;
    else groups.set(key, { job, requestCount: 1 });
  }

  const examples = [];
  for (const { job, requestCount } of groups.values()) {
    const { phase, label, startMode, schedule, nextAction } = job.presentation;
    examples.push({ id: job.id, title: job.title, phase, startMode, reserved: job.state === 'reserved',
      schedule: schedule.state, nextAction, requestCount });
    const groupLabel = `${label} (${requestCount} ${requestCount === 1 ? 'demande' : 'demandes'})`;
    const example = workQueueExample(job);
    lines.push(example ? `${groupLabel} · Exemple — ${example.text}` : groupLabel);
  }
  lines.push(`Relevé de Core · ${summary.observedAt}`);
  return { observedAt: summary.observedAt, text: lines.join('\n'), examples };
}

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
    // Agents on the owner bus may also file a coding session's plan; nobody here adds an executor.
    const sources = actor === 'owner-mcp' ? ['nestor', 'coding'] : ['nestor'];
    if (body.request?.executor || !sources.includes(body.request?.source?.type)) {
      throw fail(actor === 'owner-mcp' ? 'Agents submit planning requests only, attributed to a coding task or Nestor session'
        : 'Nestor submits planning requests only, attributed to its native session');
    }
    return view(await queue.submit(body.request, actor));
  }
  const offset = body.offset ?? 0, limit = body.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('Queue offset/limit invalid');
  const state = await queue.list();
  if (!state) throw fail('Core queue is not active; migration required', 409);
  const counts = state.jobs.reduce((result, job) => ({ ...result, [job.state]: (result[job.state] || 0) + 1 }), {});
  return { authority: state.authority, overview: overview(state), counts, count: state.count, archivedCount: state.archivedCount,
    summary: state.summary, offset, limit,
    jobs: state.jobs.slice(offset, offset + limit).map(job => view(job, { now: Date.parse(state.observedAt) })), observedAt: state.observedAt };
}
module.exports = { operate, view };

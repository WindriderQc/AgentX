'use strict';

const queue = require('../../src/services/heavyWorkQueueService');
const { project, summarize } = require('../../src/services/heavyWorkQueueReadModel');
const { handleOwnerMcp } = require('../../src/services/mcpOwnerTools');

jest.mock('../../src/services/heavyWorkQueueService', () => ({ list: jest.fn() }));

const now = Date.parse('2031-03-15T12:00:00Z');
const iso = minutes => new Date(now + minutes * 60000).toISOString();
const slot = (id, autoStart, start, end) => ({
  id, title: id, kind: 'profiler', state: 'reserved', executor: { hostId: 'example' },
  reservation: { autoStart, start: iso(start), end: iso(end) }
});
const snapshot = (jobs, time) => ({
  authority: 'core.heavy-work-queue', observedAt: new Date(time).toISOString(), count: jobs.length,
  archivedCount: 21, jobs: jobs.map(job => project(job, { now: time })), summary: summarize(jobs, { now: time })
});
const list = async offset => {
  const reply = await handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'work_queue', arguments: { action: 'list', offset, limit: 1 } } });
  expect(reply.result.isError).toBe(false);
  const nativeText = JSON.parse(reply.result.content[0].text);
  expect(nativeText).toEqual(reply.result.structuredContent);
  return nativeText;
};

test('owner queue overviews use one dated snapshot across pages, overlapping reservations and new arrivals', async () => {
  const initial = [
    { id: 'finished', state: 'completed' },
    slot('manual', false, -4, 15), slot('expired-auto', true, -30, -10), slot('future-auto', true, 5, 25)
  ];
  const jobs = [...initial,
    { id: 'proposal', title: 'Synthetic proposal', state: 'requested' },
    { id: 'another-proposal', title: 'Another synthetic proposal', state: 'requested' }
  ];
  queue.list.mockResolvedValueOnce(snapshot(initial, now)).mockResolvedValueOnce(snapshot(jobs, now + 1000));
  const first = await list(0);
  const last = await list(1);
  expect(first.overview).toBeDefined();
  expect(first.overview.text).toContain('En attente d’action 2');
  expect(last.jobs.map(job => job.id)).toEqual(['manual']);
  expect(last.overview).toMatchObject({ observedAt: last.summary.observedAt });
  expect(last.overview.text.split('\n').slice(0, 5)).toEqual([
    'Au registre 6 · Actifs 5 · Terminés 1.',
    'File automatique 1 · En attente d’action 4.',
    'Départs enregistrés 0 · Exécutions enregistrées 0 · Incertains 0 · Inconnus 0.',
    'Créneaux réservés 3 · À venir 1 · Ouverts 1 · Expirés 1 · Invalides 0.',
    'Le démarrage automatique reste soumis à la fenêtre autorisée et à l’admission native.'
  ]);
  expect(last.overview.text).toContain('créneau ouvert, départ manuel) · opérateur — déclencher pendant le créneau');
  expect(last.overview.text).toContain('créneau expiré, départ automatique) · opérateur — réexaminer la fenêtre autorisée');
  expect(last.overview.text).toContain('créneau à venir, départ automatique) · Core — attendre le créneau et l’admission native');
  for (const [id, mode, state, code, actor] of [
    ['manual', 'manual', 'open', 'run_in_slot', 'operator'],
    ['expired-auto', 'automatic', 'expired', 'review_window', 'operator'],
    ['future-auto', 'automatic', 'upcoming', 'wait_slot', 'core'],
    ['proposal', 'unconfigured', 'unreserved', 'prepare_executor', 'operator']
  ]) {
    expect(last.overview.examples).toContainEqual(expect.objectContaining({
      id, startMode: mode, schedule: state, nextAction: expect.objectContaining({ code, actor })
    }));
  }
  expect(last.overview.examples).toHaveLength(4);
  expect(queue.list).toHaveBeenCalledTimes(2);
});

test('an empty owner queue explicitly renders zero counts and has no examples', async () => {
  queue.list.mockResolvedValueOnce(snapshot([], now));
  const result = await list(0);
  expect(result.overview).toBeDefined();
  expect(result.overview.text).toContain('File automatique 0 · En attente d’action 0.');
  expect(result.overview.text).toContain('Créneaux réservés 0 · À venir 0 · Ouverts 0 · Expirés 0 · Invalides 0.');
  expect(result.overview.examples).toEqual([]);
});

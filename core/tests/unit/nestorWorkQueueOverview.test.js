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
  expect(last.overview.text).toContain('En attente d’action (1 demande) · Exemple — Demande manual ');
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
  expect(result.overview.text).not.toContain('Exemple');
  expect(result.overview.examples).toEqual([]);
});

test('the report counts all requests represented by each example and qualifies a recorded dispatch', async () => {
  const jobs = [
    { id: 'handoff', kind: 'diagnostic', state: 'dispatching', executor: { mode: 'operator' } },
    ...['manual-a', 'manual-b', 'manual-c'].map(id => slot(id, false, -10, -5)),
    ...['plan-a', 'plan-b'].map(id => ({ id, kind: 'profiler', state: 'requested', executor: { hostId: 'example' } })),
    ...['auto-a', 'auto-b', 'auto-c', 'auto-d'].map(id => slot(id, true, 5, 20))
  ];
  queue.list.mockResolvedValueOnce(snapshot(jobs, now));
  const { overview, jobs: page } = await list(0);
  expect(page.map(job => job.id)).toEqual(['handoff']);
  expect(overview.text).toContain('File automatique 4 · En attente d’action 5.');
  expect(overview.text).toContain('Départs enregistrés 1 · Exécutions enregistrées 0');
  expect(overview.examples.map(({ id, requestCount }) => [id, requestCount])).toEqual([
    ['manual-a', 3], ['plan-a', 2], ['auto-a', 4]
  ]);
  expect(overview.text).toContain('En attente d’action (3 demandes) · Exemple — Demande manual-a (créneau expiré, départ manuel) · opérateur — réexaminer la fenêtre autorisée et l’intention d’origine');
  expect(overview.text).toContain('En attente d’action (2 demandes) · Exemple — Demande plan-a (sans réservation, départ manuel) · opérateur — planifier le créneau');
  expect(overview.text).toContain('En file automatique (4 demandes) · Exemple — Demande auto-a (créneau à venir, départ automatique) · Core — attendre le créneau et l’admission native.');
  expect(overview.text).toContain('Chaque départ enregistré attend la confirmation d’exécution de l’exécuteur natif. Son mode de départ se vérifie sur la demande correspondante.');
  expect(overview.text).toContain(overview.observedAt);
});

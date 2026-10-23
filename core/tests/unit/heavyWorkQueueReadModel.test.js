'use strict';

const { presentation, project, summarize } = require('../../src/services/heavyWorkQueueReadModel');
const now = Date.parse('2030-01-01T12:00:00Z');
const before = '2030-01-01T11:00:00Z', after = '2030-01-01T13:00:00Z';
const job = (extra = {}) => ({ id: 'synthetic', state: 'requested', kind: 'profiler', executor: { hostId: 'fixture' }, ...extra });
const reserved = extra => job({ state: 'reserved', reservation: { start: before, end: after }, ...extra });
const view = value => presentation(value, { now });

test('a slot and automatic consent remain independent; a free host grants nothing', () => {
  expect(view(job())).toMatchObject({ phase: 'action_required', startMode: 'manual',
    nextAction: { code: 'plan_slot', actor: 'operator' }, capabilities: { runNow: false, configureAutoStart: true } });
  expect(view(reserved())).toMatchObject({ phase: 'action_required', startMode: 'manual',
    schedule: { state: 'open' }, capabilities: { runNow: true } });
  expect(view(reserved({ reservation: { start: before, end: after, autoStart: true } })))
    .toMatchObject({ phase: 'automatic_queue', startMode: 'automatic', nextAction: { actor: 'core' } });
  expect(view(job({ executor: null }))).toMatchObject({ phase: 'action_required', startMode: 'unconfigured',
    nextAction: { code: 'prepare_executor' }, capabilities: { runNow: false, configureAutoStart: false } });
});

test.each([
  ['profiler', { hostId: 'fixture' }],
  ['embedding-reindex', { model: 'synthetic:model', dimension: 8 }],
  ['other', { mode: 'pipeline-report', pipelineId: '0123' }],
])('the %s native launcher and operator UI share supported capabilities', (kind, executor) => {
  expect(view(reserved({ kind, executor, reservation: { start: before, end: after, autoStart: true } })))
    .toMatchObject({ phase: 'automatic_queue', capabilities: { runNow: true, configureAutoStart: true } });
});

test('accepted images are automatic even without a reserved slot; other image proposals are not', () => {
  expect(view(job({ kind: 'image', executor: { mode: 'image-operation' } })))
    .toMatchObject({ phase: 'automatic_queue', schedule: { state: 'unreserved' }, capabilities: { runNow: false, configureAutoStart: false } });
  expect(view(job({ kind: 'image', executor: { prompt: 'synthetic' } }))).toMatchObject({ phase: 'action_required', startMode: 'manual' });
  expect(view(reserved({ kind: 'diagnostic', executor: { mode: 'operator' }, reservation: { start: before, end: after, autoStart: true } })))
    .toMatchObject({ phase: 'action_required', startMode: 'manual', capabilities: { runNow: false, configureAutoStart: false } });
});

test('future, expired and malformed windows never advertise Run now or an expired automatic start', () => {
  expect(view(reserved({ reservation: { start: after, end: '2030-01-01T14:00:00Z', autoStart: true } })))
    .toMatchObject({ phase: 'automatic_queue', nextAction: { code: 'wait_slot' }, capabilities: { runNow: false } });
  for (const extra of [
    { startBefore: before },
    { reservation: { start: '2030-01-01T10:00:00Z', end: before, autoStart: true } },
    { startBefore: new Date(now).toISOString() },
  ]) expect(view(reserved(extra))).toMatchObject({ phase: 'action_required', nextAction: { code: 'review_window' }, capabilities: { runNow: false } });
  for (const reservation of [null, {}, { start: 'invalid', end: after }, { start: after, end: before }]) {
    expect(view(reserved({ reservation }))).toMatchObject({ phase: 'action_required', nextAction: { code: 'review_schedule' }, capabilities: { runNow: false } });
  }
  expect(view(job({ kind: 'image', executor: { mode: 'image-operation' }, notBefore: after })))
    .toMatchObject({ phase: 'automatic_queue', nextAction: { code: 'wait_not_before' } });
});

test('dispatch, execution and uncertainty survive the estimated end without implying release or retry', () => {
  for (const state of ['dispatching', 'running', 'uncertain']) {
    const result = view(reserved({ state, startBefore: before }));
    expect(result.phase).toBe(state);
    expect(result.capabilities.runNow).toBe(false);
    expect(result.authorization).toBe('not_granted_by_projection');
  }
  expect(view(job({ state: 'uncertain' })).nextAction).toMatchObject({ code: 'reconcile_original', actor: 'operator' });
  expect(view(job({ state: 'future-state' })).phase).toBe('unknown');
  for (const state of ['completed', 'failed', 'cancelled']) expect(view(job({ state }))).toMatchObject({ phase: 'finished', capabilities: { runNow: false } });
});

test('complete phase counts partition requests while reservations are counted independently', () => {
  const jobs = [job(), reserved(), reserved({ reservation: { start: before, end: after, autoStart: true } }),
    job({ kind: 'image', executor: { mode: 'image-operation' } }), job({ state: 'dispatching' }),
    job({ state: 'running' }), job({ state: 'uncertain' }), job({ state: 'completed' }), job({ state: 'future-state' })];
  const result = summarize(jobs, { now });
  expect(result).toMatchObject({ total: 9, active: 8, counts: { automatic_queue: 2, action_required: 2,
    dispatching: 1, running: 1, uncertain: 1, finished: 1, unknown: 1 }, reservations: { total: 2, open: 2 } });
  expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(result.total);
  expect(summarize([], { now }).counts.automatic_queue).toBe(0);
});

test('projection is deterministic, preserves native records and includes no runtime inference', () => {
  const input = reserved({ reservation: Object.freeze({ start: before, end: after, autoStart: true }) });
  Object.freeze(input);
  const original = JSON.stringify(input);
  expect(project(input, { now })).toEqual(project(input, { now }));
  expect(JSON.stringify(input)).toBe(original);
  expect(input.presentation).toBeUndefined();
});

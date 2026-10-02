'use strict';

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');
const { createTaskInMongo, findNextEligibleTask } = require('../../src/services/pipelineTaskService');
const { commitLaneTask } = require('../../src/services/pipelineLaneTaskMutationService');

describe('personal tasks in the canonical Core store', () => {
  const personal = createTrustedRuntimeServices().tasks.personal;

  beforeEach(async () => {
    await PipelineTask.deleteMany({});
    await Counter.deleteMany({ _id: 'pipelineTask' });
  });

  test('shares the canonical sequence and preserves the personal create, list, update and complete journey', async () => {
    const work = await createTaskInMongo({ title: 'Synthetic coding task', service: 'core' });
    const created = await personal.create({ title: 'Synthetic reminder', note: 'Synthetic private note', priority: 2 });
    expect(Number(created.id)).toBe(Number(work.id) + 1);
    const row = await PipelineTask.findOne({ pipelineId: created.id }).lean();
    expect(row).toMatchObject({ service: 'personal', spec: 'Synthetic private note', status: 'queued', priority: 2 });
    expect(await personal.list()).toMatchObject({ count: 1, tasks: [{ id: created.id, note: 'Synthetic private note' }] });
    expect((await findNextEligibleTask()).pipelineId).toBe(work.id);

    const edited = await personal.update({ ref: created.id, dueAt: '2030-01-02T15:00:00Z', priority: 1 });
    expect(edited).toMatchObject({ priority: 1, dueAt: '2030-01-02T15:00:00.000Z' });
    expect(await personal.complete({ ref: created.id })).toMatchObject({ alreadyDone: false, task: { status: 'done' } });
    expect(await personal.complete({ ref: created.id })).toMatchObject({ alreadyDone: true });
    expect(await personal.list()).toMatchObject({ count: 0 });
    expect(await personal.list({ includeDone: true })).toMatchObject({ count: 1 });
    expect((await PipelineTask.findOne({ pipelineId: created.id })).feedback).toHaveLength(2);
    expect((await PipelineTask.findOne({ pipelineId: created.id }).lean()).transitions.map(event => [event.seq, event.from, event.to, event.kind, event.actor.channel])).toEqual([
      [1, null, 'queued', 'created', 'personal_surface'],
      [2, 'queued', 'done', 'personal_completed', 'personal_surface'],
    ]);
  });

  test('persists task origins and retains historical origin derivation', async () => {
    const task = await personal.create({ title: 'Mail follow-up', source: 'nestor-secretary', origin: 'email' });
    expect(task.origin).toBe('email');
    expect((await PipelineTask.findOne({ pipelineId: task.id }).lean()).origin).toBe('email');
    expect((await personal.list()).tasks[0]).toMatchObject({ origin: 'email', source: 'nestor-secretary' });
    await expect(personal.create({ title: 'Invalid', origin: 'unknown' })).rejects.toMatchObject({ code: 'SECRETARY_BAD_ORIGIN' });
  });

  test('a stale same-status edit cannot overwrite a newer personal update', async () => {
    const created = await personal.create({ title: 'Synthetic reminder', priority: 3 });
    const stale = await PipelineTask.findOne({ pipelineId: created.id });
    await personal.update({ ref: created.id, priority: 1 });

    await expect(commitLaneTask(stale, { fields: { priority: 2 }, channel: 'personal_surface',
      feedback: { by: 'stale-editor', text: 'Stale edit' } }))
      .rejects.toMatchObject({ status: 409, code: 'TASK_TRANSITION_CONFLICT' });
    const saved = await PipelineTask.findOne({ pipelineId: created.id }).lean();
    expect(saved.priority).toBe(1);
    expect(saved.feedback).toHaveLength(1);
  });

  test('stores the activity date, lets Dad move or clear it, and composes the brief from every open task', async () => {
    const past = await personal.create({ title: 'Synthetic lunch', dueAt: '2026-06-05', relevantUntil: '2026-06-05' });
    expect(past).toMatchObject({ lane: 'expired', relevantUntil: '2026-06-05T00:00:00.000Z' });
    await expect(personal.create({ title: 'Invalid', relevantUntil: 'soon' })).rejects.toMatchObject({ code: 'SECRETARY_BAD_RELEVANT_UNTIL' });

    const kept = await personal.update({ ref: past.id, relevantUntil: '2099-01-01' });
    expect(kept).toMatchObject({ lane: 'overdue', relevantUntil: '2099-01-01T00:00:00.000Z' });
    const cleared = await personal.update({ ref: past.id, relevantUntil: null });
    expect(cleared.relevantUntil).toBeNull();

    for (let index = 0; index < 30; index += 1) await personal.create({ title: `Synthetic undated ${index}` });
    const briefing = await personal.briefing();
    expect(briefing.counts).toMatchObject({ open: 31, unscheduled: 30 });
    expect(briefing.lines.length).toBeLessThanOrEqual(6);
  });

  test('cannot mutate another task lane or guess an ambiguous personal reference', async () => {
    const work = await createTaskInMongo({ title: 'Synthetic reminder', service: 'core' });
    await PipelineTask.create({ pipelineId: '9999', title: 'Synthetic family routine', service: 'family' });
    await personal.create({ title: 'Synthetic reminder A' });
    await personal.create({ title: 'Synthetic reminder B' });
    for (const ref of [work.id, '9999']) {
      await expect(personal.complete({ ref })).rejects.toMatchObject({ status: 404 });
      await expect(personal.update({ ref, priority: 1 })).rejects.toMatchObject({ status: 404 });
    }
    await expect(personal.complete({ ref: 'Synthetic reminder' })).rejects.toMatchObject({ status: 409, code: 'SECRETARY_AMBIGUOUS_REF' });
    const tasks = await PipelineTask.find().lean();
    expect(tasks.every(task => task.status === 'queued')).toBe(true);
    expect(tasks.every(task => task.feedback.length === 0)).toBe(true);
  });
});

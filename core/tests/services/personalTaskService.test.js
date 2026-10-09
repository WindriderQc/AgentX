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

  test('selects current deadlines before limiting an older task backlog and reports complete counts', async () => {
    const now = new Date('2030-01-02T16:00:00Z');
    const rows = Array.from({ length: 30 }, (_, index) => ({
      pipelineId: String(index + 1).padStart(4, '0'), service: 'personal',
      title: 'Synthetic old reminder', status: 'queued', priority: 1,
      dueAt: new Date('2029-11-01T20:00:00Z'), createdAt: new Date('2029-10-01T12:00:00Z')
    }));
    rows.push({ pipelineId: '0031', service: 'personal', title: 'Synthetic current deadline',
      status: 'queued', priority: 3, dueAt: new Date('2030-01-02T22:00:00Z'), createdAt: new Date('2030-01-01T12:00:00Z') });
    rows.push({ pipelineId: '0032', service: 'personal', title: 'Synthetic recent late task',
      status: 'queued', priority: 3, dueAt: new Date('2030-01-01T22:00:00Z'), createdAt: new Date('2029-12-30T12:00:00Z') });
    rows.push({ pipelineId: '0033', service: 'core', title: 'Synthetic unrelated lane', status: 'queued', priority: 1 });
    rows.push(...Array.from({ length: 20 }, (_, index) => ({
      pipelineId: String(index + 34).padStart(4, '0'), service: 'personal',
      title: 'Synthetic recent overdue backlog', status: 'queued', priority: 1,
      dueAt: new Date('2030-01-01T22:00:00Z'), createdAt: new Date('2029-12-30T12:00:00Z')
    })));
    await PipelineTask.insertMany(rows);
    const page = await personal.list({ limit: 1 }, now);
    expect(page).toMatchObject({ count: 1, totalCount: 52, hasMore: true,
      overdueCount: 21, dueTodayCount: 1, tasks: [{ id: '0031', lane: 'today' }] });
    const next = await personal.list({ limit: 12 }, now);
    expect(next.tasks.slice(0, 2)).toMatchObject([{ id: '0031', lane: 'today', dueToday: true }, { id: '0032' }]);
    expect(next.tasks).toHaveLength(12);
    expect(next.tasks.slice(1).every(task => task.overdue)).toBe(true);
    const full = await personal.list({ limit: 100 }, now);
    expect(full).toMatchObject({ count: 52, totalCount: 52, hasMore: false });
    expect(full.tasks.filter(task => task.recheck)).toHaveLength(30);
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

  describe('the date-only deadline contract (#287)', () => {
    const previousZone = process.env.PLANNING_TIME_ZONE;
    afterEach(() => {
      if (previousZone === undefined) delete process.env.PLANNING_TIME_ZONE;
      else process.env.PLANNING_TIME_ZONE = previousZone;
    });

    test('date-only create and update store the end of the household day in America/Toronto', async () => {
      process.env.PLANNING_TIME_ZONE = 'America/Toronto';
      const created = await personal.create({ title: 'Synthetic date-only', dueAt: '2026-10-04' });
      // Sunday October 4, 23:59:59.999 EDT — the household day, not the UTC day.
      expect(created.dueAt).toBe('2026-10-05T03:59:59.999Z');
      const stored = (await PipelineTask.findOne({ pipelineId: created.id }).lean()).dueAt;
      expect(stored.toISOString()).toBe('2026-10-05T03:59:59.999Z');
      const moved = await personal.update({ ref: created.id, dueAt: '2026-11-01' });
      expect(moved.dueAt).toBe('2026-11-02T04:59:59.999Z'); // 23:59:59.999 EST.
      const spring = await personal.update({ ref: created.id, dueAt: '2026-03-08' });
      expect(spring.dueAt).toBe('2026-03-09T03:59:59.999Z'); // spring-forward day.
    });

    test('the same date-only input keeps its local day when the household zone is UTC', async () => {
      process.env.PLANNING_TIME_ZONE = 'UTC';
      const created = await personal.create({ title: 'Synthetic UTC zone', dueAt: '2026-10-04' });
      expect(created.dueAt).toBe('2026-10-04T23:59:59.999Z');
    });

    test('a full ISO datetime with an explicit offset keeps its exact instant through create and update', async () => {
      process.env.PLANNING_TIME_ZONE = 'America/Toronto';
      const created = await personal.create({ title: 'Synthetic offset', dueAt: '2026-10-03T23:59:00-04:00' });
      expect(created.dueAt).toBe('2026-10-04T03:59:00.000Z');
      const moved = await personal.update({ ref: created.id, dueAt: '2026-10-04T03:59:00.000Z' });
      expect(moved.dueAt).toBe('2026-10-04T03:59:00.000Z');
    });

    test('an invalid date is rejected with SECRETARY_BAD_DUE_DATE and stores nothing', async () => {
      process.env.PLANNING_TIME_ZONE = 'America/Toronto';
      for (const value of ['2026-13-40', '2026-02-30', '2026-10-04extra']) {
        await expect(personal.create({ title: 'Synthetic bad date', dueAt: value }))
          .rejects.toMatchObject({ code: 'SECRETARY_BAD_DUE_DATE' });
      }
      const valid = await personal.create({ title: 'Synthetic anchor', dueAt: '2026-10-04' });
      await expect(personal.update({ ref: valid.id, dueAt: 'soon' }))
        .rejects.toMatchObject({ code: 'SECRETARY_BAD_DUE_DATE' });
      // The rejection left the original deadline untouched.
      expect((await PipelineTask.findOne({ pipelineId: valid.id }).lean()).dueAt.toISOString())
        .toBe('2026-10-05T03:59:59.999Z');
    });
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

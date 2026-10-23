'use strict';
const PipelineTask = require('../../models/PipelineTask');
const personal = require('../../src/services/personalTaskService');
const ID = 'd48e901a-0083-4780-ad53-cc93a2351de3';
beforeAll(() => PipelineTask.createIndexes());
beforeEach(() => PipelineTask.deleteMany({}));

test('a captured action is created once under concurrent retries and rejects changed content', async () => {
  const input = { title: 'Synthetic repeated capture', requestId: ID, dueAt: '2030-01-01T15:00:00Z' };
  const rows = await Promise.all(Array.from({ length: 4 }, () => personal.createPersonalTask(input)));
  expect(new Set(rows.map(row => row.id)).size).toBe(1);
  expect(await PipelineTask.countDocuments({ service: 'personal' })).toBe(1);
  await expect(personal.createPersonalTask({ ...input, title: 'Different action' })).rejects.toMatchObject({ code: 'PERSONAL_CAPTURE_CONFLICT' });
});

test('completing a recurring task advances once and retains one canonical task', async () => {
  const task = await personal.createPersonalTask({ title: 'Synthetic weekly action', dueAt: '2030-10-27T10:00:00-04:00',
    repeat: { frequency: 'weekly', timeZone: 'America/Toronto', count: 2 } });
  await expect(personal.completePersonalTask({ ref: task.id })).rejects.toMatchObject({ code: 'PERSONAL_OCCURRENCE_REQUIRED' });
  const first = await personal.completePersonalTask({ ref: task.id, expectedDueAt: task.dueAt });
  expect(first).toMatchObject({ recurring: true, task: { status: 'queued', dueAt: '2030-11-03T15:00:00.000Z' } });
  expect(await personal.completePersonalTask({ ref: task.id, expectedDueAt: task.dueAt })).toMatchObject({ alreadyDone: true });
  expect((await personal.listPersonalTasks()).tasks[0]).toMatchObject({ repeat: { frequency: 'weekly' }, dueAt: first.task.dueAt });
  const final = await personal.completePersonalTask({ ref: task.id, expectedDueAt: first.task.dueAt });
  expect(final).toMatchObject({ recurring: false, task: { status: 'done' } });
  expect(await PipelineTask.countDocuments({})).toBe(1);
});

test('repetition can be changed and stopped, but cannot survive a cleared deadline', async () => {
  const task = await personal.createPersonalTask({ title: 'Synthetic action', dueAt: '2030-01-01' });
  expect(await personal.updatePersonalTask({ ref: task.id, repeat: { frequency: 'daily' } })).toMatchObject({ repeat: { frequency: 'daily' } });
  await expect(personal.updatePersonalTask({ ref: task.id, dueAt: null })).rejects.toMatchObject({ code: 'PERSONAL_REPEAT_INVALID' });
  expect(await personal.updatePersonalTask({ ref: task.id, repeat: null, dueAt: null })).toMatchObject({ repeat: null, dueAt: null });
  await expect(personal.createPersonalTask({ title: 'Missing due date', repeat: { frequency: 'weekly' } })).rejects.toMatchObject({ code: 'PERSONAL_REPEAT_INVALID' });
});

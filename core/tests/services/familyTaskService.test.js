'use strict';

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const Profile = require('../../models/HouseholdProfile');
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');
const { createTaskInMongo, findNextEligibleTask } = require('../../src/services/pipelineTaskService');
const { commitLaneTask } = require('../../src/services/pipelineLaneTaskMutationService');
const taskEditor = require('../../src/services/pipelineTaskEditorService');

describe('family task domain in the canonical Core store', () => {
  const { personal, family } = createTrustedRuntimeServices().tasks;
  beforeEach(async () => {
    await Promise.all([PipelineTask.deleteMany({}), Counter.deleteMany({}), Profile.deleteMany({})]);
  });
  afterEach(() => jest.restoreAllMocks());

  test('edits an open routine against its displayed revision and preserves child check-in evidence', async () => {
    await family.addProfile({ profileId: 'sample-child', displayName: 'Sample child' });
    const { chore } = await family.create({ profileId: 'sample-child', title: 'Original routine', cadence: 'daily' });
    const edited = await family.update({ ref: chore.id, expectedRevision: chore.revision, title: 'Updated routine', note: 'One small step', stars: 4 });
    expect(edited.chore).toMatchObject({ title: 'Updated routine', note: 'One small step', stars: 4, cadence: 'daily', status: 'queued', revision: chore.revision + 1 });
    await expect(family.update({ ref: chore.id, expectedRevision: chore.revision, title: 'Stale edit' }))
      .rejects.toMatchObject({ status: 409, code: 'FAMILY_CHORE_EDIT_CONFLICT' });
    await family.checkIn({ ref: chore.id, profileId: 'sample-child' });
    const current = (await family.list()).chores[0];
    await expect(family.update({ ref: chore.id, expectedRevision: current.revision, title: 'Different instructions' }))
      .rejects.toMatchObject({ status: 409, code: 'FAMILY_CHORE_EDIT_NOT_OPEN' });
    const saved = await PipelineTask.findOne({ pipelineId: chore.id }).lean();
    expect(saved.title).toBe('Updated routine'); expect(saved.checkedInAt).toBeInstanceOf(Date);
    expect(saved.status).toBe('review'); expect(saved.completionCount).toBe(0);
    expect(saved.transitions.map(event => event.kind)).toEqual(['created', 'family_check_in']);
    expect(saved.feedback.some(entry => entry.text.includes('Routine instructions updated'))).toBe(true);
  });

  test('routine editing refuses other lanes, archived profiles and fields that change workflow authority', async () => {
    const other = await personal.create({ title: 'Private task' });
    await family.addProfile({ profileId: 'sample-child', displayName: 'Sample child' });
    const { chore } = await family.create({ profileId: 'sample-child', title: 'Routine' });
    await expect(family.update({ ref: other.id, expectedRevision: 0, title: 'Leak' })).rejects.toMatchObject({ status: 404 });
    for (const fields of [{ status: 'done' }, { completionCount: 100 }, { cadence: 'monthly' }, { stars: 9 }, { expectedRevision: '0' }, { title: 'x'.repeat(161) }, { note: 'x'.repeat(1001) }]) {
      await expect(family.update({ ref: chore.id, expectedRevision: chore.revision, title: 'Change', ...fields })).rejects.toMatchObject({ status: 400 });
    }
    await family.archiveProfile({ profileId: 'sample-child' });
    await expect(family.update({ ref: chore.id, expectedRevision: chore.revision, title: 'Change' })).rejects.toMatchObject({ status: 404 });
    expect((await PipelineTask.findOne({ pipelineId: other.id })).title).toBe('Private task');
  });

  test('family dates remain on their chosen household day through create and edit, including DST', async () => {
    const previous = process.env.PLANNING_TIME_ZONE; process.env.PLANNING_TIME_ZONE = 'America/Toronto';
    try {
      await family.addProfile({ profileId: 'sample-child', displayName: 'Sample child' });
      const exact = new Date('2026-10-10T12:34:56.789Z');
      const timed = await family.create({ profileId: 'sample-child', title: 'Exact instant', dueAt: exact });
      expect(timed.chore.dueAt).toBe(exact.toISOString());
      const { chore } = await family.create({ profileId: 'sample-child', title: 'Dated routine', dueAt: '2026-03-08' });
      expect(chore).toMatchObject({ dueAt: '2026-03-09T03:59:59.999Z', dueDay: '2026-03-08' });
      const edited = await family.update({ ref: chore.id, expectedRevision: chore.revision, dueAt: '2026-11-01' });
      expect(edited.chore).toMatchObject({ dueAt: '2026-11-02T04:59:59.999Z', dueDay: '2026-11-01' });
      await expect(family.update({ ref: chore.id, expectedRevision: edited.chore.revision, dueAt: '2026-02-30' })).rejects.toMatchObject({ code: 'FAMILY_CHORE_BAD_DUE_DATE' });
      const cleared = await family.update({ ref: chore.id, expectedRevision: edited.chore.revision, dueAt: null });
      expect(cleared.chore.dueAt).toBeNull(); expect(cleared.chore.dueDay).toBeNull();
    } finally { if (previous === undefined) delete process.env.PLANNING_TIME_ZONE; else process.env.PLANNING_TIME_ZONE = previous; }
  });

  test('bounded family lists declare partial coverage rather than an exact total', async () => {
    await PipelineTask.insertMany(Array.from({ length: 101 }, (_, index) => ({ pipelineId: String(index + 1).padStart(4, '0'), title: 'Synthetic routine', service: 'family', status: 'queued', profileId: 'sample-child' })));
    const result = await family.list();
    expect(result.chores).toHaveLength(100); expect(result.hasMore).toBe(true);
    expect(result.timeZone).toBeTruthy(); expect(result.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('persists a family launch, child check-in, parent approval and recurring rollover in the canonical model', async () => {
    const work = await createTaskInMongo({ title: 'Synthetic engineering task', service: 'core' });
    const started = await family.launch({
      profile: { profileId: 'sample-child', displayName: 'Sample child', ageBand: 'school' },
      routines: [{ title: 'Synthetic once', stars: 2 }, { title: 'Synthetic daily', cadence: 'daily', stars: 3 }]
    });
    const [once, daily] = started.routines;
    expect(Number(once.id)).toBe(Number(work.id) + 1);
    expect(Number(daily.id)).toBe(Number(once.id) + 1);
    expect((await findNextEligibleTask()).pipelineId).toBe(work.id);
    expect(await personal.list()).toMatchObject({ count: 0 });
    expect((await family.room({ profileId: 'sample-child' })).room.available).toHaveLength(2);
    await expect(family.approve({ ref: once.id })).rejects.toMatchObject({ status: 409 });

    const stale = await PipelineTask.findOne({ pipelineId: once.id });

    expect(await family.checkIn({ ref: once.id, profileId: 'sample-child' })).toMatchObject({ alreadyWaiting: false, chore: { status: 'review' } });
    await expect(commitLaneTask(stale, { fields: { status: 'done' }, kind: 'family_approved', channel: 'family_surface' }))
      .rejects.toMatchObject({ status: 409, code: 'TASK_TRANSITION_CONFLICT' });
    expect(await family.checkIn({ ref: once.id, profileId: 'sample-child' })).toMatchObject({ alreadyWaiting: true });
    expect(await family.approve({ ref: once.id })).toMatchObject({ rolledOver: false, chore: { status: 'done', completionCount: 1, stars: 2 } });
    expect(await family.approve({ ref: once.id })).toMatchObject({ alreadyApproved: true, chore: { completionCount: 1 } });
    const onceTask = await PipelineTask.findOne({ pipelineId: once.id }).lean();
    expect(onceTask.transitions.map(event => [event.seq, event.from, event.to, event.kind, event.actor.channel])).toEqual([
      [1, null, 'queued', 'created', 'family_surface'],
      [2, 'queued', 'review', 'family_check_in', 'family_surface'],
      [3, 'review', 'done', 'family_approved', 'family_surface'],
    ]);

    await family.checkIn({ ref: daily.id, profileId: 'sample-child' });
    const approved = await family.approve({ ref: daily.id });
    expect(approved).toMatchObject({ rolledOver: true, chore: { status: 'queued', cadence: 'daily', completionCount: 1, stars: 3 } });
    expect(Date.parse(approved.chore.dueAt)).toBeGreaterThan(Date.now());
    const persisted = await PipelineTask.findOne({ pipelineId: daily.id }).lean();
    expect(persisted).toMatchObject({ profileId: 'sample-child', cadence: 'daily', completionCount: 1, stars: 3, assignee: 'household-family', checkedInAt: null });
    expect(persisted.lastCompletedAt).toBeInstanceOf(Date);
    expect(persisted.transitions.at(-1)).toMatchObject({ from: 'review', to: 'queued', kind: 'family_rolled_over' });
  });

  test('keeps child profiles and task lanes separate and preserves cancellation without a new pipeline status', async () => {
    const other = await personal.create({ title: 'Synthetic private task' });
    await family.addProfile({ profileId: 'sample-child', displayName: 'Sample child' });
    const { chore } = await family.create({ profileId: 'sample-child', title: 'Synthetic routine' });
    await expect(family.checkIn({ ref: chore.id, profileId: 'other-child' })).rejects.toMatchObject({ status: 404 });
    await expect(family.checkIn({ ref: other.id, profileId: 'sample-child' })).rejects.toMatchObject({ status: 404 });
    await expect(family.cancel({ ref: other.id })).rejects.toMatchObject({ status: 404 });
    expect(await family.cancel({ ref: chore.id })).toMatchObject({ chore: { status: 'cancelled', completedAt: null } });
    const row = await PipelineTask.findOne({ pipelineId: chore.id });
    expect(row).toMatchObject({ status: 'done', familyCancelled: true, assignee: 'household-family' });
    expect(row.transitions.at(-1)).toMatchObject({ from: 'queued', to: 'done', kind: 'family_cancelled' });
    expect(row.validateSync()).toBeUndefined();
    expect((await family.room({ profileId: 'sample-child' })).room.available).toHaveLength(0);
    expect(await family.reopen({ ref: chore.id })).toMatchObject({ chore: { status: 'queued' } });
    expect((await PipelineTask.findOne({ pipelineId: chore.id })).transitions.at(-1))
      .toMatchObject({ from: 'done', to: 'queued', kind: 'reopened' });
    expect((await family.room({ profileId: 'sample-child' })).room.available).toHaveLength(1);
    await family.archiveProfile({ profileId: 'sample-child' });
    expect(await family.listProfiles()).toEqual({ profiles: [] });
    await expect(family.create({ profileId: 'sample-child', title: 'Another synthetic routine' })).rejects.toMatchObject({ status: 404 });
    expect((await PipelineTask.findOne({ pipelineId: other.id })).status).toBe('queued');
  });

  test('compensates a partially stored family launch instead of leaving an active incomplete profile', async () => {
    const create = PipelineTask.create.bind(PipelineTask);
    jest.spyOn(PipelineTask, 'create').mockImplementationOnce(create).mockRejectedValueOnce(new Error('Synthetic storage failure'));
    await expect(family.launch({ profile: { profileId: 'sample-child', displayName: 'Sample child' },
      routines: [{ title: 'Synthetic first' }, { title: 'Synthetic second' }]
    })).rejects.toThrow('Synthetic storage failure');
    expect((await Profile.findOne({ profileId: 'sample-child' })).active).toBe(false);
    const rows = await PipelineTask.find({ service: 'family' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'done', familyCancelled: true, assignee: 'household-family' });
    expect(rows[0].transitions.map(event => event.kind)).toEqual(['created', 'family_cancelled']);
    expect(await findNextEligibleTask()).toBeNull();
  });

  test('retries launch compensation after a concurrent child check-in', async () => {
    const create = PipelineTask.create.bind(PipelineTask);
    let firstId;
    jest.spyOn(PipelineTask, 'create')
      .mockImplementationOnce(async (input) => {
        const task = await create(input);
        firstId = task.pipelineId;
        return task;
      })
      .mockRejectedValueOnce(new Error('Synthetic storage failure'));
    const update = PipelineTask.findOneAndUpdate.bind(PipelineTask);
    let injected = false;
    jest.spyOn(PipelineTask, 'findOneAndUpdate').mockImplementation(async (...args) => {
      if (!injected) {
        injected = true;
        await family.checkIn({ ref: firstId, profileId: 'sample-child' });
      }
      return update(...args);
    });

    await expect(family.launch({ profile: { profileId: 'sample-child', displayName: 'Sample child' },
      routines: [{ title: 'Synthetic first' }, { title: 'Synthetic second' }] }))
      .rejects.toThrow('Synthetic storage failure');
    const saved = await PipelineTask.findOne({ pipelineId: firstId }).lean();
    expect(saved).toMatchObject({ status: 'done', familyCancelled: true });
    expect(saved.transitions.map(event => event.kind)).toEqual(['created', 'family_check_in', 'family_cancelled']);
    expect((await Profile.findOne({ profileId: 'sample-child' })).active).toBe(false);
  });

  test('a Pipeline editor change fences a stale family approval snapshot', async () => {
    await family.addProfile({ profileId: 'sample-child', displayName: 'Sample child' });
    const { chore } = await family.create({ profileId: 'sample-child', title: 'Synthetic daily', cadence: 'daily' });
    await family.checkIn({ ref: chore.id, profileId: 'sample-child' });
    const stale = await PipelineTask.findOne({ pipelineId: chore.id });
    await taskEditor.editTask(chore.id, { editToken: taskEditor.editToken(stale),
      changes: { dueAt: '2030-01-02T15:00:00Z' } });

    await expect(commitLaneTask(stale, { fields: { status: 'queued', dueAt: new Date('2030-01-03T15:00:00Z') },
      kind: 'family_rolled_over', channel: 'family_surface' }))
      .rejects.toMatchObject({ status: 409, code: 'TASK_TRANSITION_CONFLICT' });
    expect((await PipelineTask.findOne({ pipelineId: chore.id }).lean()).dueAt.toISOString())
      .toBe('2030-01-02T15:00:00.000Z');
  });
  test('a parent birth date is set and cleared, and child-facing projections never carry it', async () => {
    await family.addProfile({ profileId: 'sample-child', displayName: 'Sample child', ageBand: 'school' });
    const set = await family.setProfileBirthDate({ profileId: 'sample-child', birthDate: '2016-03-14' });
    expect(set.profile).toMatchObject({ id: 'sample-child', birthDate: '2016-03-14' });
    expect((await family.listProfileDetails()).profiles[0].birthDate).toBe('2016-03-14');
    const childViews = [(await family.listProfiles()).profiles[0], (await family.room({ profileId: 'sample-child' })).profile];
    for (const view of childViews) {
      expect(view).not.toHaveProperty('birthDate');
      expect(JSON.stringify(view)).not.toContain('2016');
    }
    await expect(family.setProfileBirthDate({ profileId: 'sample-child', birthDate: '2999-01-01' }))
      .rejects.toMatchObject({ status: 400, code: 'FAMILY_PROFILE_BAD_BIRTH_DATE' });
    await expect(family.setProfileBirthDate({ profileId: 'missing-child', birthDate: '2016-03-14' }))
      .rejects.toMatchObject({ status: 404 });
    expect((await family.setProfileBirthDate({ profileId: 'sample-child', birthDate: '' })).profile.birthDate).toBeNull();
    expect(await Profile.findOne({ profileId: 'sample-child' }).lean()).not.toHaveProperty('birthDate');
  });
});

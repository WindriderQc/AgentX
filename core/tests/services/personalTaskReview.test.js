'use strict';

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');
const { publicTask } = require('../../src/services/personalTaskView');
const { dadDesk } = require('../../surfaces/household/briefing');
const { composePersonalBriefing } = require('../../src/services/personalBriefing');
const { SECRETARY_TOOLS, callSecretaryTool } = require('../../surfaces/household/secretary-mcp');
const { promoteToExecution, captureIdea } = require('../../src/services/ideaInboxService');
const PlanningItem = require('../../models/PlanningItem');

const now = new Date('2030-01-10T16:00:00Z');
const sourceNote = 'Secretary deep review / action secretary:synthetic-message:reply. A correspondent described a past exchange. https://mail.google.com/mail/#all/synthetic-thread';

describe('personal actions require review of extracted mail', () => {
  const personal = createTrustedRuntimeServices().tasks.personal;
  beforeEach(async () => {
    await PipelineTask.deleteMany({});
    await PlanningItem.deleteMany({});
    await Counter.deleteMany({});
  });

  test('legacy quotes, platform alerts and assistant reading stay out of focus, overdue and the spoken brief without modifying their records', async () => {
    await PipelineTask.insertMany([
      { pipelineId: '0001', service: 'personal', title: 'Reply to a quoted request', spec: sourceNote, source: 'nestor-secretary', origin: 'chat', dueAt: now },
      { pipelineId: '0002', service: 'personal', title: 'Investigate a failed CI/CD run', dueAt: now },
      { pipelineId: '0003', service: 'personal', title: 'Continuer la lecture du document (offset 8000/24000)', dueAt: now },
      { pipelineId: '0004', service: 'personal', title: 'Call the garage', source: 'household-dad-desk', dueAt: now },
      { pipelineId: '0005', service: 'core', title: 'Unrelated engineering task', dueAt: now },
    ]);
    const before = JSON.stringify(await PipelineTask.find().sort({ pipelineId: 1 }).lean());
    const snapshot = await personal.snapshot({}, now);
    expect(snapshot.filter(task => task.needsReview).map(task => task.personalReview.reason).sort()).toEqual(['assistant', 'email', 'platform']);
    expect(snapshot.find(task => task.id === '0001')).toMatchObject({ origin: 'email', overdue: false, dueToday: false, unscheduled: false, stale: false, lane: 'review' });
    const desk = dadDesk({}, snapshot, {}, now);
    expect(desk.metrics).toMatchObject({ open: 4, actionable: 1, review: 3, today: 1, overdue: 0 });
    expect(desk.focus.map(task => task.id)).toEqual(['0004']);
    expect(desk.inbox).toEqual([]);
    expect(composePersonalBriefing(snapshot, now).text).toContain('Call the garage');
    expect(composePersonalBriefing(snapshot, now).text).not.toMatch(/quoted|CI\/CD|offset/);
    expect(JSON.stringify(await PipelineTask.find().sort({ pipelineId: 1 }).lean())).toBe(before);
    const reprojected = snapshot.map(task => publicTask(task, now));
    expect(reprojected.map(task => [task.id, task.lane, task.personalReview])).toEqual(snapshot.map(task => [task.id, task.lane, task.personalReview]));
  });

  test('an extractor cannot self-approve; human review edits the action and explicitly clears an invented date while retaining source and history', async () => {
    const proposed = await personal.create({ title: 'A correspondent says we should arrange a meeting', note: sourceNote, origin: 'email', dueAt: '2030-01-02', personalReview: { state: 'accepted' }, ownerCapture: true });
    expect(proposed).toMatchObject({ needsReview: true, lane: 'review' });
    await expect(personal.complete({ ref: proposed.id })).rejects.toMatchObject({ code: 'SECRETARY_REVIEW_REQUIRED' });
    await expect(personal.review({ ref: proposed.id, revision: proposed.revision, decision: 'accept', title: 'Choose a meeting time' }))
      .rejects.toMatchObject({ code: 'SECRETARY_REVIEW_ACTION_REQUIRED' });
    const accepted = await personal.review({ ref: proposed.id, revision: proposed.revision, decision: 'accept', title: 'Choose a meeting time', dueAt: null });
    expect(accepted).toMatchObject({ title: 'Choose a meeting time', dueAt: null, relevantUntil: null, needsReview: false, lane: 'inbox', note: sourceNote });
    const saved = await PipelineTask.findOne({ pipelineId: proposed.id }).lean();
    expect(saved.personalReview).toMatchObject({ state: 'accepted', reason: 'email', reviewedAt: expect.any(Date) });
    expect(saved.feedback[0].text).toContain(proposed.title);
    expect((await personal.list()).tasks).toMatchObject([{ id: proposed.id }]);
    await personal.complete({ ref: proposed.id });
    expect((await personal.list()).count).toBe(0);
    expect(SECRETARY_TOOLS.some(tool => /review_personal|approve_personal/.test(tool.name))).toBe(false);
  });

  test('a stale human review refuses after a concurrent edit and cannot overwrite its deadline', async () => {
    const proposed = await personal.create({ title: 'Arrange a call', origin: 'email' });
    await personal.update({ ref: proposed.id, dueAt: '2030-02-03' });
    await expect(personal.review({ ref: proposed.id, revision: proposed.revision, decision: 'accept', title: 'Arrange a call', dueAt: null }))
      .rejects.toMatchObject({ code: 'SECRETARY_REVIEW_CONFLICT' });
    const latest = (await personal.list({ scope: 'review' })).tasks[0];
    expect(latest.dueAt).not.toBeNull();
    expect(latest.needsReview).toBe(true);
  });

  test('dismiss is reversible and never claims completion or deletes the task or its source', async () => {
    const proposed = await personal.create({ title: 'An old request', note: sourceNote });
    const dismissed = await personal.review({ ref: proposed.id, revision: proposed.revision, decision: 'dismiss' });
    expect(dismissed).toMatchObject({ status: 'queued', lane: 'dismissed', note: sourceNote });
    expect(await personal.list()).toMatchObject({ count: 0, reviewCount: 0 });
    const page = await personal.list({ scope: 'dismissed' });
    expect(page).toMatchObject({ findingCount: 1, categoryCounts: { email: 1, action: 0 } });
    expect(page.tasks[0]).toMatchObject({ id: proposed.id, lane: 'dismissed' });
    const restored = await personal.review({ ref: proposed.id, revision: dismissed.revision, decision: 'restore' });
    expect(restored).toMatchObject({ needsReview: true, lane: 'review' });
    expect((await PipelineTask.findOne({ pipelineId: proposed.id }).lean()).feedback).toHaveLength(2);
  });

  test('counts cover more than one page and a current manual action survives a large imported backlog', async () => {
    await PipelineTask.insertMany(Array.from({ length: 184 }, (_, index) => ({
      pipelineId: String(index + 1).padStart(4, '0'), service: 'personal', title: `Synthetic imported action ${index}`, origin: 'email',
    })));
    await PipelineTask.create({ pipelineId: '0185', service: 'personal', title: 'Call a friend', dueAt: now });
    expect(await personal.list({ scope: 'active', limit: 1 }, now)).toMatchObject({ count: 1, totalCount: 1, reviewCount: 184, tasks: [{ id: '0185' }] });
    expect(await personal.list({ limit: 1 }, now)).toMatchObject({ totalCount: 185, reviewCount: 184, categoryCounts: { action: 1, email: 184, platform: 0, assistant: 0 } });
    expect(await personal.list({ category: 'email', limit: 1 }, now)).toMatchObject({ totalCount: 184, tasks: [{ category: 'email', needsReview: true }] });
    const first = await personal.list({ scope: 'review', limit: 100 }, now);
    const second = await personal.list({ scope: 'review', limit: 100, offset: first.nextOffset }, now);
    expect(first).toMatchObject({ count: 100, totalCount: 184, reviewCount: 184, nextOffset: 100 });
    expect(second).toMatchObject({ count: 84, totalCount: 184, hasMore: false, nextOffset: null });
    expect(new Set([...first.tasks, ...second.tasks].map(task => task.id)).size).toBe(184);
    expect(dadDesk({}, await personal.snapshot({}, now), {}, now).metrics).toMatchObject({ open: 185, actionable: 1, review: 184 });
  });

  test('ordinary captures and human-promoted mail ideas stay accepted; technical and reading tasks cannot be accepted unchanged', async () => {
    const direct = await personal.create({ title: 'Water the plants', source: 'nestor-secretary' });
    const french = await personal.create({ title: 'Rappeler celui-ci demain' });
    expect(direct.needsReview).toBe(false);
    expect(french.needsReview).toBe(false);
    const idea = await captureIdea({ text: 'Book a checkup', origin: 'secretary' });
    const promoted = await promoteToExecution(idea.idea.id, { targetType: 'personal', summary: sourceNote });
    expect((await personal.list()).tasks.find(task => task.id === promoted.task.pipelineId).needsReview).toBe(false);
    for (const title of ['Fix Dependabot alerts', 'Review GitHub CI failure', 'Continuer la lecture du document']) {
      const proposed = await personal.create({ title }, { ownerCapture: true });
      expect(proposed.needsReview).toBe(true);
      await expect(personal.review({ ref: proposed.id, revision: proposed.revision, decision: 'accept', title, dueAt: null }))
        .rejects.toMatchObject({ code: 'SECRETARY_NOT_PERSONAL_ACTION' });
    }
    await expect(personal.create({ title: 'a'.repeat(201) })).rejects.toMatchObject({ code: 'SECRETARY_TITLE_TOO_LONG' });
    const receipt = await callSecretaryTool('add_personal_task', { title: 'Follow up on a request', origin: 'email' }, { personalTasks: personal });
    expect(receipt.structuredContent).toMatchObject({ needsReview: true, lane: 'review' });
  });
});

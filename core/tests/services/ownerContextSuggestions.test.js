'use strict';

// Synthetic records only: these tests prove the suggestion contract
// (deterministic rules, provenance, exclusions, bounds, unavailable sources,
// no side effect), not the usefulness of real suggestions.
const MemoryNote = require('../../models/MemoryNote');
const PersonalTaskDossier = require('../../models/PersonalTaskDossier');
const PersonalTaskEvidenceSignal = require('../../models/PersonalTaskEvidenceSignal');
const PipelineTask = require('../../models/PipelineTask');
const { suggest, localDay } = require('../../src/services/ownerContextSuggestions');
const { currentFactFilter } = require('../../src/services/memoryNoteValidity');

const MODELS = [MemoryNote, PersonalTaskDossier, PersonalTaskEvidenceSignal, PipelineTask];
// 2026-11-09 03:30 UTC is still 2026-11-08 in America/Toronto.
const NOW = new Date('2026-11-09T03:30:00Z');
const env = { PLANNING_TIME_ZONE: 'America/Toronto' };
const noAtlas = async () => ({ authority: 'agentx.core', pending: 0, inbox: '/atlas/#proposals', proposals: [] });
const stores = (overrides = {}) => ({ MemoryNote, PersonalTaskDossier, PersonalTaskEvidenceSignal, PipelineTask, currentFactFilter,
  atlasStatus: noAtlas, ...overrides });
const souvenir = fields => MemoryNote.create({ packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private',
  kind: 'souvenir', text: 'Synthetic sealed souvenir text', sourceRefs: [{ system: 'testimony', id: 'synthetic-source-1' }], ...fields });
const signal = (key, fields) => PersonalTaskEvidenceSignal.create({ key: key.repeat(32).slice(0, 32), fingerprint: key, threadId: 'thread-synthetic',
  messageId: `msg-${key}`, sourceStatus: 'current', text: 'Synthetic mail text', ...fields });

describe('owner context suggestions (#24)', () => {
  beforeAll(async () => { for (const model of MODELS) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => { for (const model of MODELS) await model.deleteMany({}); });

  test('the household day follows the planning time zone', () => {
    expect(localDay(NOW, 'America/Toronto')).toBe('2026-11-08');
    expect(localDay(NOW, 'UTC')).toBe('2026-11-09');
  });

  test('new mail evidence on an open personal task proposes a dossier read, with its sources', async () => {
    await PipelineTask.create([
      { pipelineId: '9101', title: 'Synthetic renewal', service: 'personal', status: 'queued' },
      { pipelineId: '9102', title: 'Synthetic reviewed', service: 'personal', status: 'in_progress' },
      { pipelineId: '9103', title: 'Synthetic closed', service: 'personal', status: 'done' },
      { pipelineId: '9104', title: 'Engineering', service: 'core', status: 'queued' },
    ]);
    await signal('a', { taskIds: ['9101'], sourceDate: new Date('2026-11-05T12:00:00Z') });
    await signal('b', { taskIds: ['9102', '9103', '9104'], sourceDate: new Date('2026-11-01T12:00:00Z') });
    await PersonalTaskDossier.collection.insertOne({ taskId: '9102', taskRevision: 1, snapshot: {}, fingerprint: 'f', createdAt: new Date('2026-11-03T12:00:00Z') });
    await PersonalTaskDossier.collection.insertOne({ taskId: '9101', taskRevision: 1, snapshot: {}, fingerprint: 'f', createdAt: new Date('2026-11-02T12:00:00Z') });

    const answer = await suggest({}, { stores: stores(), now: NOW, env });
    expect(answer.suggestions).toHaveLength(1);
    expect(answer.suggestions[0]).toMatchObject({ type: 'task_evidence_review', effect: 'proposal_only',
      whyNow: { sourceDate: '2026-11-05T12:00:00.000Z', reviewedAt: '2026-11-02T12:00:00.000Z' },
      evidence: [{ system: 'personal_task', id: '9101', status: 'queued' }, { system: 'mail', messageId: 'msg-a', threadId: 'thread-synthetic' }],
      proposedAction: { tool: 'personal_task_dossier' } });
    expect(JSON.stringify(answer)).not.toContain('Synthetic mail text');
    expect(answer.status).toMatchObject({ complete: true, unavailable: [], truncated: false });
    // A proposal only: no task, dossier or signal changed.
    expect(await PipelineTask.find({}, { _id: 0, status: 1 }).sort({ pipelineId: 1 }).lean()).toEqual([
      { status: 'queued' }, { status: 'in_progress' }, { status: 'done' }, { status: 'queued' }]);
    expect(await PersonalTaskDossier.countDocuments({})).toBe(2);
  });

  test('anniversaries come only from active, current, day-precise souvenirs within the horizon', async () => {
    const tomorrow = await souvenir({ eventDate: '2016-11-09', eventDatePrecision: 'day' });
    await souvenir({ eventDate: '2016-11-20', eventDatePrecision: 'day' });               // beyond 7 days
    await souvenir({ eventDate: '2016-11', eventDatePrecision: 'month' });              // partial date
    await souvenir({ eventDate: '', eventDatePrecision: 'unknown' });                   // unknown date
    await souvenir({ eventDate: '2010-11-10', eventDatePrecision: 'day', status: 'forgotten' });
    await souvenir({ eventDate: '2011-11-10', eventDatePrecision: 'day', invalidatedAt: new Date('2026-01-01') });
    await souvenir({ eventDate: '2026-11-09', eventDatePrecision: 'day' });              // this year: no anniversary

    const answer = await suggest({ horizonDays: 7 }, { stores: stores(), now: NOW, env });
    expect(answer.suggestions).toEqual([expect.objectContaining({ type: 'souvenir_anniversary', title: 'Il y a 10 ans : souvenir du 2016-11-09',
      whyNow: { anniversary: '2026-11-09', inDays: 1, today: '2026-11-08' },
      evidence: [{ system: 'memory_note', id: String(tomorrow._id), kind: 'souvenir', date: '2016-11-09', precision: 'day', sourceCount: 1 }] })]);
    expect(JSON.stringify(answer)).not.toContain('Synthetic sealed souvenir text');
    expect((await suggest({ horizonDays: 0 }, { stores: stores(), now: NOW, env })).suggestions).toEqual([]);
  });

  test('pending Life Atlas proposals point to the owner inbox; an unavailable rule is named', async () => {
    const atlasStatus = async () => ({ pending: 2, inbox: '/atlas/#proposals', proposals: [{ id: 'p1' }] });
    const answer = await suggest({}, { stores: stores({ atlasStatus, PersonalTaskEvidenceSignal: { find: () => { throw new Error('offline'); } } }), now: NOW, env });
    expect(answer.suggestions).toEqual([expect.objectContaining({ type: 'life_atlas_review', title: '2 propositions Life Atlas à relire',
      evidence: [{ system: 'life_history', id: 'proposals', link: '/atlas/#proposals', pending: 2 }] })]);
    expect(answer.status).toMatchObject({ complete: false, unavailable: ['task_evidence_review'] });
  });

  test('results are bounded, keys are stable, and invalid bounds are refused before any read', async () => {
    for (let day = 9; day <= 14; day += 1) await souvenir({ eventDate: `2015-11-${String(day).padStart(2, '0')}`, eventDatePrecision: 'day' });
    const first = await suggest({ limit: 3 }, { stores: stores(), now: NOW, env });
    const again = await suggest({ limit: 3 }, { stores: stores(), now: NOW, env });
    expect(first.suggestions).toHaveLength(3);
    expect(first.suggestions.map(item => item.whyNow.inDays)).toEqual([1, 2, 3]);
    expect(first.status).toMatchObject({ total: 6, truncated: true, complete: false });
    expect(again.suggestions.map(item => item.key)).toEqual(first.suggestions.map(item => item.key));
    const find = jest.fn();
    for (const input of [{ limit: 0 }, { limit: 11 }, { horizonDays: 15 }, { horizonDays: 1.5 }, []]) {
      await expect(suggest(input, { stores: stores({ MemoryNote: { find } }), now: NOW, env })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    }
    expect(find).not.toHaveBeenCalled();
  });
});

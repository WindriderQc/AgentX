'use strict';

// Synthetic records only. These tests prove the link contract (exact
// identifiers, exclusions, bounds, unavailable sources and audience binding),
// not the usefulness of real answers.
const MailJournalEntry = require('../../models/MailJournalEntry');
const PersonalHistoryEntry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const PersonalTaskDossier = require('../../models/PersonalTaskDossier');
const PersonalTaskEvidenceSignal = require('../../models/PersonalTaskEvidenceSignal');
const PipelineTask = require('../../models/PipelineTask');
const links = require('../../src/services/ownerContextLinks');

const MODELS = [MailJournalEntry, PersonalHistoryEntry, MemoryNote, PersonalTaskDossier, PersonalTaskEvidenceSignal, PipelineTask];
const sha = n => String(n).repeat(64).slice(0, 64);
const NOW = new Date('2026-11-07T12:00:00Z');

const recallHit = (n, extra = {}) => ({ text: `Synthetic excerpt ${n}`, score: 0.8, metadata: {
  documentId: `mail:msg-synthetic-${n}`, source: 'owner-recall', scope: 'owner', sensitivity: 'private', kind: 'mail',
  title: `Synthetic subject ${n}`, occurredAt: null, people: [],
  provenance: { messageId: `msg-synthetic-${n}`, threadId: `thread-synthetic-${n}`, sourceSha256: sha(n) }, ...extra } });

const historySource = (n, extra = {}) => ({ system: 'gmail', id: `msg-synthetic-${n}`, threadId: `thread-synthetic-${n}`,
  messageId: `msg-synthetic-${n}`, sourceSha256: sha(n), findingId: sha(n + 1), ...extra });

const note = (fields) => MemoryNote.create({ packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private',
  kind: 'souvenir', text: 'Synthetic kept souvenir', ...fields });

describe('owner context links (#24)', () => {
  beforeAll(async () => { for (const model of MODELS) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => { for (const model of MODELS) await model.deleteMany({}); });

  test('links only records that share the exact message or thread, and never closed, forgotten, replaced or expired ones', async () => {
    await MailJournalEntry.create([
      { key: 'j1', threadId: 'thread-synthetic-1', messageId: 'msg-synthetic-1', occurredAt: new Date('2024-05-01'), subject: 'Synthetic digest', summary: 's', sourceRef: 'gmail:msg-synthetic-1' },
      { key: 'j2', threadId: 'thread-synthetic-1', occurredAt: new Date('2024-05-02'), subject: 'Synthetic later digest', summary: 's' },
      { key: 'j3', threadId: 'thread-synthetic-1', occurredAt: new Date('2024-05-03'), subject: 'Expired', summary: 's', expiresAt: new Date('2026-01-01') },
      { key: 'j4', threadId: 'thread-synthetic-10', occurredAt: new Date('2024-05-03'), subject: 'Near miss', summary: 's' },
    ]);
    const moment = await PersonalHistoryEntry.create({ key: 'h1', kind: 'fact', text: 'Synthetic moment without a date', source: historySource(1) });
    await PersonalHistoryEntry.create({ key: 'h2', kind: 'fact', text: 'Forgotten', reviewState: 'forgotten', forgottenAt: NOW, source: historySource(1, { findingId: sha(7) }) });
    const kept = await note({ eventDate: '2024-05', eventDatePrecision: 'month', sourceRefs: [{ system: 'gmail', id: 'msg-synthetic-1' }] });
    await note({ status: 'forgotten', sourceRefs: [{ system: 'gmail', id: 'msg-synthetic-1' }] });
    await note({ invalidatedAt: new Date('2026-01-01'), sourceRefs: [{ system: 'gmail', id: 'msg-synthetic-1' }] });
    await PipelineTask.create([
      { pipelineId: '9001', title: 'Synthetic open task', service: 'personal', status: 'queued' },
      { pipelineId: '9002', title: 'Synthetic done task', service: 'personal', status: 'done' },
      { pipelineId: '9003', title: 'Engineering task', service: 'core', status: 'queued' },
      { pipelineId: '9004', title: 'Synthetic signalled task', service: 'personal', status: 'blocked' },
    ]);
    await PersonalTaskDossier.collection.insertMany([
      { taskId: '9001', snapshot: { selection: { threadIds: ['thread-synthetic-1'] } } },
      { taskId: '9002', snapshot: { selection: { threadIds: ['thread-synthetic-1'] } } },
      { taskId: '9003', snapshot: { selection: { threadIds: ['thread-synthetic-1'] } } },
    ]);
    await PersonalTaskEvidenceSignal.create({ key: 'k'.repeat(32), fingerprint: 'f', threadId: 'thread-synthetic-1', messageId: 'msg-synthetic-1', taskIds: ['9004'] });

    const { results, linkStatus } = await links.attach([recallHit(1)], { now: NOW });
    expect(linkStatus).toEqual({ basis: 'exact_identifiers', complete: true, unavailable: [], truncated: false });
    const found = results[0].links.map(link => `${link.system}:${link.id}:${link.relation}`);
    expect(found).toHaveLength(6);
    expect(found).toEqual(expect.arrayContaining([
      `life_history:${moment._id}:same_message`,
      expect.stringMatching(/^mail_journal:[a-f0-9]{24}:same_message$/),
      expect.stringMatching(/^mail_journal:[a-f0-9]{24}:same_thread$/),
      `memory_note:${kept._id}:same_message`,
      'personal_task:9001:same_thread',
      'personal_task:9004:same_thread',
    ]));
    // Same-message links come before same-thread ones.
    expect(found.slice(0, 3).every(item => item.endsWith(':same_message'))).toBe(true);
    const historyLink = results[0].links.find(link => link.system === 'life_history');
    expect(historyLink).toMatchObject({ date: null, precision: 'unknown', link: `/atlas/#entry:${moment._id}`, assertionState: 'unknown' });
    expect(results[0].links.find(link => link.system === 'memory_note')).toMatchObject({ date: '2024-05', precision: 'month' });
    expect(JSON.stringify(results)).not.toContain('Synthetic kept souvenir');
    expect(JSON.stringify(results)).not.toMatch(/Expired|Near miss|Forgotten|done task|Engineering/);
    // A link is a pointer: nothing was written.
    expect(await PipelineTask.find({}, { status: 1, _id: 0 }).sort({ pipelineId: 1 }).lean())
      .toEqual([{ status: 'queued' }, { status: 'done' }, { status: 'queued' }, { status: 'blocked' }]);
    expect(await PersonalHistoryEntry.countDocuments({})).toBe(2);
  });

  test('a kept souvenir links to its own moment; shared RAG results are never anchors', async () => {
    const souvenir = await note({ sourceRefs: [{ system: 'personal-history', id: 'synthetic-entry' }] });
    const moment = await PersonalHistoryEntry.create({ key: 'h3', kind: 'fact', text: 'Synthetic kept moment', eventDate: '2004', eventDatePrecision: 'year',
      souvenirNoteId: String(souvenir._id), source: historySource(3) });
    const souvenirHit = { text: 'Synthetic souvenir', score: 0.7, metadata: { source: 'owner-recall', kind: 'souvenir', souvenirNoteId: String(souvenir._id), provenance: null } };
    const shared = { text: 'Synthetic vault page', score: 0.9, metadata: { source: 'vault', provenance: { messageId: 'msg-synthetic-3' } } };
    const { results } = await links.attach([shared, souvenirHit], { now: NOW });
    expect(results[0].links).toEqual([]);
    expect(results[1].links).toEqual([expect.objectContaining({ system: 'life_history', id: String(moment._id), relation: 'kept_souvenir', date: '2004', precision: 'year' })]);
  });

  test('an unreadable source is named and never reads as absence', async () => {
    await MailJournalEntry.create({ key: 'j5', threadId: 'thread-synthetic-5', occurredAt: new Date('2024-01-01'), subject: 'Synthetic digest', summary: 's' });
    const stores = { MailJournalEntry, PersonalHistoryEntry: { find: () => { throw new Error('history store offline'); } }, MemoryNote,
      PersonalTaskDossier, PersonalTaskEvidenceSignal, PipelineTask, currentFactFilter: require('../../src/services/memoryNoteValidity').currentFactFilter,
      momentLink: id => `/atlas/#entry:${id}` };
    const warn = jest.fn();
    const { results, linkStatus } = await links.attach([recallHit(5)], { stores, now: NOW, logger: { warn } });
    expect(linkStatus).toMatchObject({ complete: false, unavailable: ['life_history'] });
    expect(results[0].links).toEqual([expect.objectContaining({ system: 'mail_journal', relation: 'same_thread' })]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ source: 'life_history' }));
  });

  test('provider identifiers are compared verbatim, including Message-ID and export forms', async () => {
    const messageId = '<synthetic.42@example.test>', threadId = 'Inbox/Synthetic thread 42';
    await MailJournalEntry.create([
      { key: 'v1', threadId, messageId, occurredAt: new Date('2010-02-01'), subject: 'Synthetic verbatim', summary: 's' },
      { key: 'v2', threadId: 'inbox/synthetic thread 42', occurredAt: new Date('2010-02-01'), subject: 'Synthetic case variant', summary: 's' },
    ]);
    const hit = recallHit(42, { provenance: { messageId, threadId, sourceSha256: sha(4) } });
    const { results } = await links.attach([hit], { now: NOW });
    expect(results[0].links).toEqual([expect.objectContaining({ title: 'Synthetic verbatim', relation: 'same_message' })]);
  });

  test('links stay bounded per result and report truncation', async () => {
    await MailJournalEntry.create(Array.from({ length: links.PER_RESULT + 3 }, (_, i) =>
      ({ key: `b${i}`, threadId: 'thread-synthetic-6', occurredAt: new Date(2024, 0, i + 1), subject: `Synthetic ${i}`, summary: 's' })));
    const { results, linkStatus } = await links.attach([recallHit(6)], { now: NOW });
    expect(results[0].links).toHaveLength(links.PER_RESULT);
    expect(linkStatus).toMatchObject({ complete: false, truncated: true });
  });

  test('recall binds the owner-private audience itself and keeps the existing envelope', async () => {
    const memoryRead = require('../../src/services/memoryReadService');
    const search = jest.fn(async () => [recallHit(8)]);
    const forAudience = jest.spyOn(memoryRead, 'forAudience').mockReturnValue({ search });
    try {
      const answer = await links.recall('  Synthetic lake  ', { limit: 3, now: NOW });
      expect(forAudience).toHaveBeenCalledWith('owner-private');
      expect(search).toHaveBeenCalledWith('Synthetic lake', { topK: 3 });
      expect(answer).toMatchObject({ authority: 'agentx.core', query: 'Synthetic lake', linkStatus: { complete: true },
        results: [expect.objectContaining({ text: 'Synthetic excerpt 8', links: [] })] });
    } finally { forAudience.mockRestore(); }
  });
});

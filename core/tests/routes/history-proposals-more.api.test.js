'use strict';

const express = require('express');
const request = require('supertest');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const Proposal = require('../../models/HistoryProposal');
const history = require('../../src/services/personalHistoryService');
const context = require('../../src/services/personalHistoryContextService');
const { createHistoryProposals } = require('../../src/services/historyProposalService');
const { registerSecretaryProposalRoutes } = require('../../surfaces/household/secretary-proposals');
const { createSouvenirRecallSync } = require('../../src/services/souvenirRecallSync');

const proposals = createHistoryProposals({ env: { CORE_PUBLIC_URL: 'https://agentx.example.test' } });
const owner = express();
owner.use(express.json());
const router = express.Router();
registerSecretaryProposalRoutes({ router, proposals, envelope: (res, data) => res.json({ status: 'success', data }),
  fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) });
owner.use('/api/secretary', router);
const nestor = body => proposals.operateForNestor(body);
const native = () => history.record({ kind: 'fact', text: 'Synthetic move to a new apartment.', sourceDate: '2014-06-02T10:00:00-04:00',
  places: ['Synthetic city'], source: { system: 'gmail', threadId: 'thread0001', messageId: 'message0001', sourceSha256: 'a'.repeat(64), findingId: 'f'.repeat(64) } });

describe('Nestor corrects moments read from mail and proposes new moments', () => {
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression, Proposal]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => { for (const model of [Entry, MemoryNote, Suppression, Proposal]) await model.deleteMany({}); });

  test('a moment read from mail is corrected from the owner\'s words, which become its testimony source', async () => {
    const { entry } = await native();
    const { moment } = await nestor({ operation: 'get', entryId: entry.id });
    expect(moment).toMatchObject({ target: 'native', revision: 0 });
    await expect(nestor({ operation: 'propose', entryId: entry.id, changes: { date: '2014-07-01', precision: 'day' }, rationale: 'r' }))
      .rejects.toMatchObject({ statusCode: 400 });
    const { proposal } = await nestor({ operation: 'propose', entryId: entry.id, changes: { date: '2014-07-01', precision: 'day', place: 'Synthetic town' },
      rationale: 'The owner said when and where the move happened.', evidence: [{ quote: 'we moved to Synthetic town on July 1st, 2014', source: 'conversation' }] });
    expect(proposal).toMatchObject({ target: 'native', baseRevision: 0, before: { date: null, precision: 'unknown', place: 'Synthetic city' } });
    expect((await context.get(entry.id)).entry.timeline).toBeNull();
    const accepted = (await request(owner).post(`/api/secretary/proposals/${proposal.id}/accept`).send({}).expect(200)).body.data;
    expect(accepted.moment).toMatchObject({ target: 'context', date: '2014-07-01', precision: 'day', place: 'Synthetic town' });
    const after = (await context.get(entry.id, { includeSourceBodies: true })).entry;
    expect(after).toMatchObject({ contextRevision: 2, timeline: { date: '2014-07-01', place: 'Synthetic town', confirmationBasis: 'owner-testimony' } });
    expect(after.context.sources[0]).toMatchObject({ kind: 'testimony', authority: 'direct-owner-statement', body: 'we moved to Synthetic town on July 1st, 2014' });
    expect(after.context.ownerEdits).toHaveLength(1);
    expect(after.context.importedTimeline.date).toBeNull();
  });

  test('a moment read from mail that changed since the proposal is not touched', async () => {
    const { entry } = await native();
    const { proposal } = await nestor({ operation: 'propose', entryId: entry.id, changes: { title: 'Synthetic move' }, rationale: 'r',
      evidence: [{ quote: 'it was our move' }] });
    await history.review(entry.id, { state: 'retained', reason: 'Synthetic review', revision: 0 });
    await request(owner).post(`/api/secretary/proposals/${proposal.id}/accept`).send({}).expect(409);
    expect((await context.get(entry.id)).entry.timeline).toBeNull();
    expect((await Proposal.findById(proposal.id).lean()).state).toBe('stale');
  });

  test('a new moment waits for the owner, then becomes a candidate whose source is the owner\'s words', async () => {
    const proposed = await nestor({ operation: 'add', moment: { title: 'Synthetic canoe trip', description: 'A week on a synthetic lake.',
      date: '1998-07', precision: 'month', place: 'Synthetic lake', category: 'travel', people: ['Synthetic Friend'] },
      rationale: 'The owner told this story in conversation.', evidence: [{ quote: 'in July 1998 we spent a week canoeing on Synthetic lake', source: 'conversation' }] });
    expect(proposed).toMatchObject({ created: true, proposal: { target: 'new', entryId: '', link: null, moment: { title: 'Synthetic canoe trip', precision: 'month' } } });
    expect(await Entry.countDocuments()).toBe(0);
    const again = await nestor({ operation: 'add', moment: { title: 'Synthetic canoe trip', description: 'A week on a synthetic lake.',
      date: '1998-07', precision: 'month', place: 'Synthetic lake', category: 'travel', people: ['Synthetic Friend'] },
      rationale: 'Same.', evidence: [{ quote: 'in July 1998 we spent a week canoeing on Synthetic lake' }] });
    expect(again.created).toBe(false);
    expect(await require('../../surfaces/household/secretary-routes').lifeAtlasPending()).toEqual({ pending: 1, href: '/atlas/#proposals' });
    const accepted = (await request(owner).post(`/api/secretary/proposals/${proposed.proposal.id}/accept`).send({}).expect(200)).body.data;
    expect(accepted.proposal).toMatchObject({ state: 'accepted', link: expect.stringContaining('/atlas/#entry:') });
    const created = (await context.get(accepted.proposal.entryId, { includeSourceBodies: true })).entry;
    expect(created).toMatchObject({ reviewState: 'candidate', souvenirNoteId: '', people: ['Synthetic Friend'],
      source: { system: 'testimony' }, timeline: { title: 'Synthetic canoe trip', date: '1998-07', precision: 'month', category: 'travel' } });
    expect(created.context.sources[0].body).toBe('in July 1998 we spent a week canoeing on Synthetic lake');
    const status = await nestor({ operation: 'status' });
    expect(status).toMatchObject({ pending: 0, inbox: 'https://agentx.example.test/atlas/#proposals' });
  });

  test('new moments are validated before storing and need the owner\'s words', async () => {
    const good = { title: 'Synthetic event', date: '2001', precision: 'year' };
    for (const bad of [{ moment: undefined }, { moment: { ...good, sourceIds: ['x'] } }, { moment: { ...good, date: '2001-13', precision: 'month' } },
      { moment: { title: '' } }, { evidence: [] }, { rationale: '' }, { moment: { ...good, people: 'one' } }]) {
      await expect(nestor({ operation: 'add', moment: good, rationale: 'r', evidence: [{ quote: 'it happened in 2001' }], ...bad }))
        .rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await Proposal.countDocuments()).toBe(0);
  });
});

describe('a kept souvenir reaches the private recall right away', () => {
  test('debounced once, only where the recall is configured, and failures never surface', async () => {
    let calls = 0, fire;
    const sync = createSouvenirRecallSync({ setTimer: fn => { fire = fn; return {}; },
      recall: () => ({ configured: () => true, sync: async () => { calls += 1; throw new Error('RAG down'); } }) });
    expect(sync.schedule()).toBe(true);
    expect(sync.schedule()).toBe(true);
    await fire();
    expect(calls).toBe(1);
    expect(createSouvenirRecallSync({ recall: () => ({ configured: () => false }) }).schedule()).toBe(false);
  });
});

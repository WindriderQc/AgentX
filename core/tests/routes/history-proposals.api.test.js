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
const { input } = require('../fixtures/personalHistoryContext');

const proposals = createHistoryProposals({ env: { CORE_PUBLIC_URL: 'https://agentx.example.test' } });
const owner = express();
owner.use(express.json());
const router = express.Router();
registerSecretaryProposalRoutes({ router, proposals, envelope: (res, data) => res.json({ status: 'success', data }),
  fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) });
owner.use('/api/secretary', router);

async function contextual(n = 1) {
  const [result] = (await context.importBatch({ entries: [input(n)] })).results;
  return result.entry;
}
const nestor = body => proposals.operateForNestor(body);

describe('corrections Nestor proposes and the owner decides', () => {
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression, Proposal]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => { for (const model of [Entry, MemoryNote, Suppression, Proposal]) await model.deleteMany({}); });

  test('Nestor finds and reads a moment with its link and the revision to propose against', async () => {
    const entry = await contextual();
    const found = await nestor({ operation: 'search', query: 'Synthetic move' });
    expect(found.moments[0]).toMatchObject({ id: entry.id, target: 'context', revision: 1, link: `https://agentx.example.test/atlas/#entry:${entry.id}` });
    const { moment } = await nestor({ operation: 'get', entryId: entry.id });
    expect(moment).toMatchObject({ title: 'Synthetic move 1', date: '2004', precision: 'year', kept: false });
    await expect(nestor({ operation: 'accept', entryId: entry.id })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a proposal changes nothing until the owner accepts it, then applies through the context edit', async () => {
    const entry = await contextual();
    const proposed = await nestor({ operation: 'propose', entryId: entry.id, changes: { date: '2004-06-12', precision: 'day', place: 'Synthetic town' },
      rationale: 'The owner said in conversation that the move happened on June 12.', evidence: [{ quote: 'we moved on June 12', source: 'conversation' }] });
    expect(proposed).toMatchObject({ created: true, proposal: { target: 'context', baseRevision: 1, state: 'pending',
      before: { date: '2004', precision: 'year', place: null }, changes: { date: '2004-06-12', precision: 'day', place: 'Synthetic town', ageStartWindow: null } } });
    expect((await context.get(entry.id)).entry.timeline.date).toBe('2004');
    const again = await nestor({ operation: 'propose', entryId: entry.id, changes: { date: '2004-06-12', precision: 'day', place: 'Synthetic town' }, rationale: 'Same again.' });
    expect(again.created).toBe(false);
    const inbox = (await request(owner).get('/api/secretary/proposals').expect(200)).body.data;
    expect(inbox).toMatchObject({ pending: 1 });
    const accepted = (await request(owner).post(`/api/secretary/proposals/${proposed.proposal.id}/accept`).send({}).expect(200)).body.data;
    expect(accepted).toMatchObject({ proposal: { state: 'accepted', decision: { appliedRevision: 2 } }, moment: { date: '2004-06-12', precision: 'day', place: 'Synthetic town' } });
    const after = (await context.get(entry.id)).entry;
    expect(after).toMatchObject({ contextRevision: 2, timeline: { date: '2004-06-12', place: 'Synthetic town', ageStartWindow: null } });
    expect(after.context.ownerEdits).toHaveLength(1);
    await request(owner).post(`/api/secretary/proposals/${proposed.proposal.id}/accept`).send({}).expect(409);
  });

  test('a moment edited since the proposal is never overwritten: the proposal becomes stale', async () => {
    const entry = await contextual();
    const { proposal } = await nestor({ operation: 'propose', entryId: entry.id, changes: { title: 'Nestor title' }, rationale: 'Clearer title.' });
    await context.edit(entry.id, { revision: 1, changes: { timeline: { title: 'Owner title' } } });
    const stale = await request(owner).post(`/api/secretary/proposals/${proposal.id}/accept`).send({}).expect(409);
    expect(stale.body.code).toBe('HISTORY_PROPOSAL_STALE');
    expect((await context.get(entry.id)).entry.timeline.title).toBe('Owner title');
    expect((await Proposal.findById(proposal.id).lean()).state).toBe('stale');
  });

  test('the owner refuses with a reason; refused and decided proposals cannot be decided again', async () => {
    const entry = await contextual();
    const { proposal } = await nestor({ operation: 'propose', entryId: entry.id, changes: { category: 'work' }, rationale: 'It was a work move.' });
    const refused = (await request(owner).post(`/api/secretary/proposals/${proposal.id}/refuse`).send({ reason: 'It was a family move.' }).expect(200)).body.data;
    expect(refused.proposal).toMatchObject({ state: 'refused', decision: { reason: 'It was a family move.' } });
    await request(owner).post(`/api/secretary/proposals/${proposal.id}/accept`).send({}).expect(409);
    expect((await context.get(entry.id)).entry.timeline.category).toBe('home');
    const status = await nestor({ operation: 'status' });
    expect(status.proposals[0]).toMatchObject({ state: 'refused' });
  });

  test('a kept souvenir is corrected through its own edit; invalid proposals are refused before storing', async () => {
    const entry = await contextual();
    const kept = await history.keepAsSouvenir(entry.id, { revision: 0, contextRevision: 1 });
    const { moment } = await nestor({ operation: 'get', entryId: entry.id });
    expect(moment).toMatchObject({ kept: true, target: 'souvenir' });
    await expect(nestor({ operation: 'propose', entryId: entry.id, changes: { title: 'x' }, rationale: 'r' })).rejects.toMatchObject({ statusCode: 400 });
    const { proposal } = await nestor({ operation: 'propose', entryId: entry.id, changes: { eventDate: '2004-06-12', people: ['Synthetic Friend'] }, rationale: 'Owner named the friend.' });
    expect(proposal).toMatchObject({ target: 'souvenir', baseRevision: moment.revision });
    await request(owner).post(`/api/secretary/proposals/${proposal.id}/accept`).send({}).expect(200);
    const note = await MemoryNote.findById(kept.souvenirNoteId).lean();
    expect(note).toMatchObject({ eventDate: '2004-06-12', eventDatePrecision: 'day', people: ['Synthetic Friend'] });
    for (const bad of [{ changes: { sourceIds: ['x'] } }, { changes: {} }, { changes: { eventDate: '2004-13-40' } }, { rationale: '' }]) {
      await expect(nestor({ operation: 'propose', entryId: entry.id, changes: { eventDate: '2005-01-01' }, rationale: 'ok', ...bad })).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(nestor({ operation: 'propose', entryId: 'f'.repeat(24), changes: { title: 'x' }, rationale: 'r' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('a native candidate without context cannot be corrected by Nestor yet', async () => {
    const { entry } = await history.record({ kind: 'fact', text: 'Synthetic native fact', sourceDate: '2014-06-02T10:00:00-04:00',
      source: { system: 'gmail', threadId: 'thread0001', messageId: 'message0001', sourceSha256: 'a'.repeat(64), findingId: 'f'.repeat(64) } });
    await expect(nestor({ operation: 'propose', entryId: entry.id, changes: { title: 'x' }, rationale: 'r' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

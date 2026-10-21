'use strict';

const express = require('express');
const request = require('supertest');
const Person = require('../../models/PersonContact');
const Observation = require('../../models/PersonObservation');
const Proposal = require('../../models/PersonMergeProposal');
const MemoryNote = require('../../models/MemoryNote');
const people = require('../../src/services/peopleRegistryService');
const { personal } = require('../../src/services/memoryNoteService');
const { registerSecretaryPeopleRoutes } = require('../../surfaces/household/secretary-people');

const sha = n => String(n).repeat(64);
const header = (n, name, mail, extra = {}) => ({ source: 'gmail-header', role: 'from', direction: 'received', name, email: mail,
  occurredAt: `2019-0${n}-01T12:00:00Z`, ref: { threadId: `thread0${n}`, messageId: `message0${n}`, sourceSha256: sha(n) }, ...extra });
const card = (n, name, mail, phones = []) => ({ source: 'outlook-vcf', role: 'vcard', name, email: mail, phones,
  ref: { sourceSha256: sha(n), assertionId: sha(n + 1) } });

describe('owner people registry', () => {
  beforeAll(async () => {
    for (const model of [Person, Observation, Proposal, MemoryNote]) { await model.createCollection(); await model.createIndexes(); }
  });
  beforeEach(async () => { for (const model of [Person, Observation, Proposal, MemoryNote]) await model.deleteMany({}); });

  test('a mail address finds the same person again and an import replays safely', async () => {
    const first = await people.observe([header(1, 'Synthetic Friend', 'Friend@Example.test'), header(2, 'Synthetic Friend', 'friend@example.test')]);
    expect(first).toMatchObject({ created: 2, replayed: 0, people: 1 });
    expect(await people.observe([header(1, 'Synthetic Friend', 'Friend@Example.test')])).toMatchObject({ created: 0, replayed: 1 });
    const { people: rows, total } = await people.list();
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ displayName: 'Synthetic Friend', emails: ['friend@example.test'], exchanges: 2 });
    expect(new Date(rows[0].firstSeen).toISOString()).toBe('2019-01-01T12:00:00.000Z');
  });

  test('a contact card sharing a phone with another person proposes a merge, never makes one', async () => {
    await people.observe([header(1, 'Synthetic Cousin', 'cousin@example.test'), card(3, 'Cousin S.', 'cousin.home@example.test', ['+1 (514) 555-0101'])]);
    expect((await people.list()).total).toBe(2);
    await people.observe([card(5, 'Synthetic Cousin', 'cousin@example.test', ['514-555-0101'])]);
    const { proposals } = await people.proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ reason: 'shared-phone', evidence: '5145550101', state: 'proposed' });
    expect((await people.list()).total).toBe(2);
  });

  test('a shared full name is a suggestion; a single first name is not', async () => {
    await people.observe([header(1, 'Synthetic Neighbour', 'one@example.test'), header(2, 'synthétic NEIGHBOUR', 'two@example.test'),
      header(3, 'Sam', 'sam1@example.test'), header(4, 'Sam', 'sam2@example.test')]);
    const { proposals } = await people.proposals();
    expect(proposals.map(p => [p.reason, p.evidence])).toEqual([['same-name', 'synthetic neighbour']]);
  });

  test('the owner accepts a merge, and undoing it restores both people exactly', async () => {
    await people.observe([header(1, 'Synthetic Aunt', 'aunt@example.test'), header(2, 'Synthetic Aunt', 'aunt.work@example.test')]);
    const [proposal] = (await people.proposals()).proposals;
    await expect(people.accept(proposal.id, { revision: 3 })).rejects.toMatchObject({ statusCode: 409 });
    await people.accept(proposal.id, { revision: 0 });
    const merged = (await people.list()).people;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ exchanges: 2, emails: expect.arrayContaining(['aunt@example.test', 'aunt.work@example.test']) });
    expect((await people.proposals()).proposals).toEqual([]);
    expect((await people.proposals({ state: 'accepted' })).proposals[0]).toMatchObject({ state: 'accepted', revision: 1 });
    await people.undo(proposal.id, { revision: 1 });
    const split = (await people.list()).people;
    expect(split.map(p => p.emails).sort()).toEqual([['aunt.work@example.test'], ['aunt@example.test']]);
    expect(split.every(p => p.exchanges === 1)).toBe(true);
    // An undone merge can be accepted again, or dismissed.
    await people.dismiss(proposal.id, { revision: 2 });
    expect((await people.proposals()).proposals).toEqual([]);
  });

  test('undo is refused when a later merge built on the kept person', async () => {
    await people.observe([header(1, 'Synthetic Pair', 'p1@example.test'), header(2, 'Synthetic Pair', 'p2@example.test')]);
    const [first] = (await people.proposals()).proposals;
    await people.accept(first.id, { revision: 0 });
    const kept = (await people.list()).people[0].id;
    await Person.updateOne({ _id: kept }, { $set: { state: 'merged', mergedInto: 'a'.repeat(24) } });
    await expect(people.undo(first.id, { revision: 1 })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('a person shows their exchanges, contact cards and the souvenirs that name them', async () => {
    await people.observe([header(1, 'Synthetic Friend', 'friend@example.test'),
      card(3, 'Synthetic Friend', 'friend@example.test', ['5145550199'])]);
    await personal().keepSouvenir({ text: 'Synthetic canoe trip', people: ['Synthetic Friend'],
      sourceRefs: [{ system: 'gmail', id: sha(1) }] });
    const [person] = (await people.list({ query: 'friend' })).people;
    const detail = await people.show(person.id);
    expect(detail.exchanges).toEqual([expect.objectContaining({ role: 'from', direction: 'received',
      archiveUrl: `/api/secretary/archive/message01?sha256=${sha(1)}` })]);
    expect(detail.cards).toEqual([expect.objectContaining({ phones: ['5145550199'] })]);
    expect(detail.souvenirs.map(s => s.text)).toEqual(['Synthetic canoe trip']);
  });

  test('invalid observations are refused before any write', async () => {
    for (const bad of [{ ...header(1, 'X', 'x@example.test'), role: 'vcard' }, header(1, 'X', 'not-an-address'),
      { ...header(1, 'X', 'x@example.test'), ref: { messageId: 'message01', sourceSha256: 'short' } },
      { ...card(3, '', '', []) }]) {
      await expect(people.observe([header(2, 'Y', 'y@example.test'), bad])).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(await Observation.countDocuments()).toBe(0);
    expect(await Person.countDocuments()).toBe(0);
  });

  test('HTTP routes record observations and decide merges', async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerSecretaryPeopleRoutes({ router, envelope: (res, data) => res.json({ status: 'success', data }),
      fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) });
    app.use('/api/secretary', router);
    await request(app).post('/api/secretary/people/observations').send({ observations: [] }).expect(400);
    await request(app).post('/api/secretary/people/observations')
      .send({ observations: [header(1, 'Synthetic Pal', 'pal1@example.test'), header(2, 'Synthetic Pal', 'pal2@example.test')] }).expect(200);
    const merges = (await request(app).get('/api/secretary/people/merges').expect(200)).body.data.proposals;
    await request(app).post(`/api/secretary/people/merges/${merges[0].id}/accept`).send({ revision: 0 }).expect(200);
    expect((await request(app).get('/api/secretary/people').expect(200)).body.data.total).toBe(1);
    await request(app).get('/api/secretary/people/not-an-id').expect(400);
  });
});

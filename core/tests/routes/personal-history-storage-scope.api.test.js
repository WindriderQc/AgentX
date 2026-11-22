'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const privacy = require('../../src/services/personalHistoryPrivacy');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { storagePacket } = require('../fixtures/historyStoragePacket');
const API = '/api/secretary/history/storage-scope';
const source = { system: 'gmail', messageId: '1234567890abcdef', threadId: '2234567890abcdef', sourceSha256: 'a'.repeat(64) };
const other = { ...source, messageId: '1234567890abcdea' };
const mount = (control, audience = 'owner') => {
  const app = express(), router = express.Router(); app.use(express.json());
  registerSecretaryHistoryRoutes({ router, preservationDeps: { audience, control },
    envelope: (res, data) => res.json({ ok: true, data }),
    fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
  app.use('/api/secretary', router); return app;
};
describe('selected native storage scope owner API', () => {
  let control, app, id;
  const observe = extra => request(app).post(API).send({ sources: [source], observationId: randomUUID(), ...extra });
  beforeAll(async () => { for (const model of [Entry, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic body excluded from storage evidence', sourceDate: null,
      source: { ...source, findingId: 'd'.repeat(64) } })).entry.id;
    control = { probeStorageEvidence: jest.fn(async (copy, input) => storagePacket(input, copy)) }; app = mount(control);
  });
  afterEach(() => jest.restoreAllMocks());

  test('two complete passes observe distinct kernel identifiers without accepting physical preservation or changing data', async () => {
    const rows = await Entry.find({}).lean(); const result = await observe().expect(200), first = result.body.data;
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(first).toMatchObject({ status: 'observed', physicalIndependenceAccepted: false, semanticAcceptance: false,
      authenticatedPerson: null, approvalBound: false, mailboxEffects: 0, executionAllowed: false, cleanupStatus: 'blocked',
      nativeValidationGaps: GAPS, snapshot: { coverage: { counts: { messages: 1, distinctKernelDeviceMessages: 1, heldMessages: 0 }, blockers: [] } } });
    expect(first.fingerprint).toBe(digest(first.snapshot));
    expect(control.probeStorageEvidence.mock.calls.map(([copy]) => copy)).toEqual(['primary', 'mirror', 'primary', 'mirror']);
    expect(control.probeStorageEvidence.mock.calls[0][1].requestId).not.toBe(control.probeStorageEvidence.mock.calls[2][1].requestId);
    const second = (await observe({ expected: first.fingerprint }).expect(200)).body.data;
    expect(second.status).toBe('observed_match'); expect(second.snapshot).toEqual(first.snapshot);
    expect(await Entry.find({}).lean()).toEqual(rows);
    for (const privateMarker of ['Synthetic body', '/sys/', '/dev/', 'serial']) expect(JSON.stringify(first)).not.toContain(privateMarker);
  });
  test.each(['unqualified', 'shared_disk', 'same_machine', 'mismatched_content'])('holds native evidence %s while retaining all gaps', async variant => {
    control.probeStorageEvidence.mockImplementation(async (copy, input) => {
      const proof = storagePacket(input, copy);
      if (variant === 'unqualified' && copy === 'mirror') Object.assign(proof.storage, { status: 'unqualified', physicalDiskIdsSha256: [], blockers: ['unsupported_storage_topology'] });
      if (variant === 'shared_disk') proof.storage.physicalDiskIdsSha256 = ['b'.repeat(64)];
      if (variant === 'same_machine') proof.machineIdSha256 = '1'.repeat(64);
      if (variant === 'mismatched_content' && copy === 'mirror') proof.metadataSha256 = 'f'.repeat(64);
      return proof;
    });
    const value = (await observe().expect(200)).body.data;
    expect(value.snapshot.members[0].coverage.state).toBe('held');
    expect(value.snapshot.coverage.counts.heldMessages).toBe(1); expect(value.nativeValidationGaps).toEqual(GAPS);
  });
  test.each([
    p => { p.storage.files = true; }, p => { p.storage.filesSha256 = 'f'.repeat(64); },
    p => { p.storage.physicalIndependenceAccepted = true; }, p => { p.storage.physicalDiskIdsSha256.push(...p.storage.physicalDiskIdsSha256); },
    p => { p.storage.host = 'forged'; }, p => { p.storage.status = 'unqualified'; },
    p => { p.restoration.temporaryCopyRemoved = false; }, p => { p.requestId = randomUUID(); }
  ])('malformed/rebound native evidence returns unavailable without partial scope', async mutate => {
    control.probeStorageEvidence.mockImplementation(async (copy, input) => { const proof = storagePacket(input, copy); mutate(proof); return proof; });
    const value = (await observe().expect(503)).body; expect(value.data).toBeUndefined(); expect(value.code).toBe('HISTORY_STORAGE_UNAVAILABLE');
  });
  test('an earlier selected copy changing during the second full pass refuses the entire set', async () => {
    let calls = 0; control.probeStorageEvidence.mockImplementation(async (copy, input) => {
      const proof = storagePacket(input, copy); if (++calls >= 5 && input.messageId === source.messageId) proof.storage.physicalDiskIdsSha256 = ['f'.repeat(64)]; return proof;
    });
    await observe({ sources: [other, source] }).expect(409);
  });
  test('a late erasure while reading a later source cannot release an earlier source snapshot', async () => {
    let calls = 0; control.probeStorageEvidence.mockImplementation(async (copy, input) => {
      if (++calls === 8) await privacy.suppress({ _id: id }); return storagePacket(input, copy);
    });
    const failed = (await observe({ sources: [other, source] }).expect(409)).body; expect(failed.data).toBeUndefined();
  });
  test('native failures disclose no transport location and never relaunch', async () => {
    control.probeStorageEvidence.mockRejectedValue(new Error('Synthetic secret transport location'));
    const failed = (await observe().expect(503)).body;
    expect(control.probeStorageEvidence).toHaveBeenCalledTimes(1); expect(failed.data).toBeUndefined(); expect(JSON.stringify(failed)).not.toContain('secret transport');
  });
  test('family scope and forged/partial selections refuse before native work', async () => {
    await request(mount(control, 'family')).post(API).send({ sources: [source], observationId: randomUUID() }).expect(403);
    for (const extra of [{ host: 'forged' }, { physicalIndependenceAccepted: true }, { sources: [] }, { sources: [source, source] }, { observationId: 'bad' }, { expected: true }]) await observe(extra).expect(400);
    expect(control.probeStorageEvidence).not.toHaveBeenCalled();
  });
});

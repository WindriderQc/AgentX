'use strict';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Confirmation = require('../../models/PersonalHistoryManifestConfirmation');
const evidence = require('../../src/services/personalHistoryManifestConfirmationEvidence');
const confirmation = require('../../src/services/personalHistoryManifestConfirmation');
const contract = require('../../src/services/personalHistoryManifestConfirmationContract');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const BASE = '/api/secretary/history/manifest-confirmations';
const source = { system: 'gmail', messageId: '1234567890abcdef', threadId: '2234567890abcdef', sourceSha256: 'a'.repeat(64) };
const checks = [{ entryId: 'a'.repeat(24), requestId: '00000000-0000-4000-8000-000000000001', snapshotHash: 'b'.repeat(64), source }];
const selected = () => ({ checks, before: '2026-01-01T00:00:00.000Z' });
const packet = marker => {
  const preview = { manifest: { synthetic: marker || 'review' }, coreRestoration: { synthetic: 'native' } };
  const manifestSha256 = digest(preview.manifest), coreRestorationSha256 = digest(preview.coreRestoration);
  return { preview, manifestSha256, coreRestorationSha256, bindingSha256: contract.binding(manifestSha256, coreRestorationSha256) };
};
const mount = (audience = 'owner') => {
  const app = express(), router = express.Router(); app.use(express.json());
  registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience }, preservationDeps: { audience }, mailboxScopeDeps: { audience },
    envelope: (res, data) => res.json({ ok: true, data }),
    fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
  app.use('/api/secretary', router); return app;
};
const app = mount();

describe('current native binding of a historical human confirmation', () => {
  let key;
  const input = extra => ({ ...selected(), observationId: randomUUID(), ...extra });
  const observe = (extra, instance = app) => request(instance).post(`${BASE}/${key}/current`).send(input(extra));
  beforeAll(async () => Confirmation.createCollection());
  beforeEach(async () => {
    await Confirmation.deleteMany({}); key = randomUUID();
    const { preview, ...hashes } = packet();
    await Confirmation.create({ _id: digest(key), inputSha256: digest(selected()), ...hashes, state: 'confirmed',
      preparedAt: new Date('2026-01-01T00:00:00.000Z'), confirmedAt: new Date('2026-01-01T00:00:01.000Z') });
    jest.spyOn(evidence, 'observe').mockImplementation(async () => packet());
    jest.spyOn(evidence, 'assertCurrent').mockResolvedValue();
  });
  afterEach(() => jest.restoreAllMocks());

  test('two fresh observations bind the immutable receipt without preview, source data or writes', async () => {
    const before = await Confirmation.findById(digest(key)).lean(), firstInput = input();
    const reply = await request(app).post(`${BASE}/${key}/current`).send(firstInput).expect(200), first = reply.body.data;
    expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(first).toMatchObject({ contract: 'agentx.history-manifest-confirmation-current/v1', observationId: firstInput.observationId,
      status: 'observed', atomicBatch: false, semanticAcceptance: false, authenticatedPerson: null, approvalBound: false,
      mailboxEffects: 0, executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS,
      snapshot: { requestId: key, inputSha256: digest(selected()), checksSha256: digest(checks), sourceSetSha256: digest([source]),
        selectedMessages: 1, confirmationStatus: 'current', confirmation: { contract: contract.CONTRACT, requestId: key,
          bindingSha256: packet().bindingSha256, authenticatedPerson: null, recordedVia: 'private_lan_surface' },
        current: { bindingSha256: packet().bindingSha256 } } });
    expect(first.fingerprint).toBe(digest(first.snapshot));
    const second = (await observe({ expected: first.fingerprint }).expect(200)).body.data;
    expect(second.status).toBe('observed_match'); expect(second.snapshot).toEqual(first.snapshot);
    expect(second.observationId).not.toBe(first.observationId);
    expect(await Confirmation.findById(digest(key)).lean()).toEqual(before);
    expect(await Confirmation.countDocuments()).toBe(1);
    expect(JSON.stringify(first)).not.toMatch(/1234567890abcdef|2234567890abcdef|sourceSha256|preview|synthetic/);
    expect(evidence.observe).toHaveBeenCalledTimes(2); expect(evidence.assertCurrent).toHaveBeenCalledTimes(2);
  });

  test('a complete different native proof reports changed currency and cannot endorse the old confirmation', async () => {
    evidence.observe.mockResolvedValue(packet('changed'));
    const first = (await observe().expect(200)).body.data;
    expect(first.snapshot.confirmationStatus).toBe('changed');
    expect(first.snapshot.confirmation.bindingSha256).toBe(packet().bindingSha256);
    expect(first.snapshot.current.bindingSha256).toBe(packet('changed').bindingSha256);
    const sameChanged = (await observe({ expected: first.fingerprint }).expect(200)).body.data;
    expect(sameChanged.status).toBe('observed_match'); expect(sameChanged.snapshot.confirmationStatus).toBe('changed');
    expect(sameChanged.executionAllowed).toBe(false); expect(sameChanged.approvalBound).toBe(false);
    expect((await confirmation.get(key, { audience: 'owner', findings: { audience: 'owner' },
      preservation: { audience: 'owner' }, mailbox: { audience: 'owner' } })).state).toBe('confirmed');
  });

  test.each(['preparing', 'prepared', 'confirming', 'blocked'])('an original %s receipt cannot launch current verification', async state => {
    await Confirmation.updateOne({ _id: digest(key) }, { $set: { state } });
    await observe().expect(409); expect(evidence.observe).not.toHaveBeenCalled();
  });
  test('unknown identity, wrong original selection and forged fields refuse before native work', async () => {
    key = randomUUID(); await observe().expect(404);
    const row = await Confirmation.findOne().lean();
    key = randomUUID(); // Restore a known request from its retained local identity.
    await Confirmation.create({ ...row, _id: digest(key) });
    await observe({ before: '2025-01-01T00:00:00.000Z' }).expect(409);
    for (const field of ['actor', 'confirmation', 'verified', 'snapshot', 'audience', 'grant']) {
      await observe({ [field]: 'owner' }).expect(400);
    }
    expect(evidence.observe).not.toHaveBeenCalled();
  });
  test.each([409, 503])('native unavailable %s is never a changed/missing/current source claim', async statusCode => {
    const before = await Confirmation.findById(digest(key)).lean();
    evidence.observe.mockRejectedValue(Object.assign(new Error('private source host and body'), { statusCode }));
    const failed = await observe().expect(503);
    expect(failed.body.code).toBe('HISTORY_MANIFEST_CONFIRMATION_CURRENT_UNAVAILABLE');
    expect(failed.body.data).toBeUndefined(); expect(JSON.stringify(failed.body)).not.toContain('private source');
    expect(await Confirmation.findById(digest(key)).lean()).toEqual(before); expect(evidence.observe).toHaveBeenCalledTimes(1);
  });
  test('a changed original receipt during native verification cannot pass as the same human inspection', async () => {
    evidence.observe.mockImplementation(async () => {
      await Confirmation.updateOne({ _id: digest(key) }, { $set: { confirmedAt: new Date('2026-01-01T00:00:02.000Z') } });
      return packet();
    });
    await observe().expect(409); expect(evidence.assertCurrent).not.toHaveBeenCalled();
  });
  test('late privacy/source failure after receipt reads withholds every currency claim', async () => {
    evidence.assertCurrent.mockRejectedValue(Object.assign(new Error('erased during final receipt await'), { statusCode: 409 }));
    const failed = await observe().expect(503); expect(failed.body.data).toBeUndefined();
    expect((await Confirmation.findById(digest(key)).lean()).state).toBe('confirmed');
  });
  test('a future or inverted historical date refuses before any native verification', async () => {
    await Confirmation.updateOne({ _id: digest(key) }, { $set: { preparedAt: new Date('2026-01-02T00:00:00.000Z') } });
    await observe().expect(409);
    await Confirmation.updateOne({ _id: digest(key) }, { $set: { confirmedAt: new Date(Date.now() + 86400000) } });
    await observe().expect(409); expect(evidence.observe).not.toHaveBeenCalled();
  });
  test('server family scope refuses before reading receipt storage or native services', async () => {
    const read = jest.spyOn(Confirmation, 'findById'); await observe({}, mount('family')).expect(403);
    expect(read).not.toHaveBeenCalled(); expect(evidence.observe).not.toHaveBeenCalled();
  });
});

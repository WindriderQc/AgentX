'use strict';

const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const Confirmation = require('../../models/PersonalHistoryManifestConfirmation');
const evidence = require('../../src/services/personalHistoryManifestConfirmationEvidence');
const contract = require('../../src/services/personalHistoryManifestConfirmationContract');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const URL = '/api/secretary/history/manifest-confirmations';
const source = { system: 'gmail', messageId: '1234567890abcdef', threadId: '2234567890abcdef', sourceSha256: 'a'.repeat(64) };
const checks = [{ entryId: 'a'.repeat(24), requestId: '00000000-0000-4000-8000-000000000001', snapshotHash: 'b'.repeat(64), source }];
const selection = () => ({ checks, before: '2026-01-01T00:00:00.000Z' });
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
const prepare = async key => (await request(app).post(URL).send({ requestId: key, ...selection() }).expect(200)).body.data;
const confirmBody = prepared => ({ ...selection(), bindingSha256: prepared.bindingSha256, confirmation: 'reviewed_selected_manifest' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

describe('native exact-manifest confirmation ownership and uncertain replies', () => {
  beforeAll(async () => Confirmation.createCollection());
  beforeEach(async () => {
    await Confirmation.deleteMany({});
    jest.spyOn(evidence, 'observe').mockImplementation(async () => packet());
    jest.spyOn(evidence, 'assertCurrent').mockResolvedValue();
  });
  afterEach(() => jest.restoreAllMocks());

  test('records human intent against exact evidence; persists no selection, source or preview', async () => {
    const key = randomUUID(), prepared = await prepare(key);
    expect(prepared).toMatchObject({ state: 'prepared', nativeState: 'observed', replayed: false, preview: packet().preview,
      authenticatedPerson: null, recordedVia: 'private_lan_surface', approvalBound: false, executionAllowed: false,
      semanticAcceptance: false, cleanupStatus: 'blocked', mailboxEffects: 0, nativeValidationGaps: GAPS });
    const response = await request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const receipt = response.body.data;
    expect(receipt).toMatchObject({ state: 'confirmed', bindingSha256: prepared.bindingSha256,
      nativeState: 'not_rechecked', approvalBound: false, executionAllowed: false, authenticatedPerson: null });
    expect(receipt.preview).toBeUndefined();
    expect(receipt.confirmedAt).toEqual(expect.any(String));
    expect(evidence.observe).toHaveBeenCalledTimes(2);
    const stored = await Confirmation.findById(digest(key)).lean();
    expect(Object.keys(stored).sort()).toEqual(['_id', 'inputSha256', 'state', 'bindingSha256', 'manifestSha256',
      'coreRestorationSha256', 'preparedAt', 'confirmedAt', 'blockedCode', 'createdAt', 'updatedAt', '__v'].sort());
    expect(JSON.stringify(stored)).not.toMatch(/1234567890abcdef|2234567890abcdef|synthetic|sourceSha256|checks|preview/);
    evidence.observe.mockRejectedValue(new Error('private source has been forgotten'));
    const historical = (await request(app).get(`${URL}/${key}`).expect(200)).body.data;
    expect(historical.state).toBe('confirmed'); expect(historical.nativeState).toBe('not_rechecked');
    expect(historical.preview).toBeUndefined();
    expect((await request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).expect(200)).body.data.replayed).toBe(true);
    expect(evidence.observe).toHaveBeenCalledTimes(2);
  });

  test('GET404 is unknown; replayed preparation cannot silently repeat native verification', async () => {
    const key = randomUUID();
    expect((await request(app).get(`${URL}/${key}`).expect(404)).body.code).toBe('HISTORY_MANIFEST_CONFIRMATION_UNKNOWN');
    const prepared = await prepare(key);
    const repeat = await prepare(key);
    expect(repeat).toMatchObject({ state: 'prepared', bindingSha256: prepared.bindingSha256, replayed: true, nativeState: 'not_rechecked' });
    expect(repeat.preview).toBeUndefined(); expect(evidence.observe).toHaveBeenCalledTimes(1);
    const reopened = (await request(app).post(`${URL}/${key}/reopen`).send(selection()).expect(200)).body.data;
    expect(reopened).toMatchObject({ state: 'prepared', replayed: true, nativeState: 'observed', preview: packet().preview });
    expect(evidence.observe).toHaveBeenCalledTimes(2);
  });

  test('concurrent preparations reserve native _id before any native launch', async () => {
    const key = randomUUID(), entered = deferred(), release = deferred();
    evidence.observe.mockImplementation(async () => { entered.resolve(); await release.promise; return packet(); });
    const first = request(app).post(URL).send({ requestId: key, ...selection() }).then(value => value);
    await entered.promise;
    const peer = await prepare(key); expect(peer.state).toBe('preparing');
    expect((await request(app).get(`${URL}/${key}`).expect(200)).body.data.state).toBe('preparing');
    expect(evidence.observe).toHaveBeenCalledTimes(1);
    release.resolve(); expect((await first).body.data.state).toBe('prepared');
    expect(await Confirmation.countDocuments()).toBe(1);
  });

  test('concurrent confirmations retain the original binding and launch exactly once', async () => {
    const key = randomUUID(), prepared = await prepare(key), entered = deferred(), release = deferred();
    evidence.observe.mockClear().mockImplementation(async () => { entered.resolve(); await release.promise; return packet(); });
    const first = request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).then(value => value);
    await entered.promise;
    const peer = (await request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).expect(200)).body.data;
    expect(peer.state).toBe('confirming'); expect(evidence.observe).toHaveBeenCalledTimes(1);
    expect((await request(app).post(`${URL}/${key}/reopen`).send(selection()).expect(200)).body.data.state).toBe('confirming');
    release.resolve(); expect((await first).body.data.state).toBe('confirmed');
  });

  function loseUpdateAck(state) {
    const original = Confirmation.findOneAndUpdate.bind(Confirmation);
    jest.spyOn(Confirmation, 'findOneAndUpdate').mockImplementation((...args) => {
      const query = original(...args), lean = query.lean.bind(query);
      query.lean = async () => { const row = await lean();
        if (args[1].$set.state === state) throw new Error('synthetic lost acknowledgement'); return row; };
      return query;
    });
  }
  test.each(['prepared', 'confirmed'])('lost %s acknowledgement reconciles the original without a second native launch', async state => {
    const key = randomUUID(); if (state === 'prepared') loseUpdateAck(state);
    const prepared = await prepare(key);
    expect(prepared.state).toBe('prepared');
    if (state === 'confirmed') loseUpdateAck(state);
    const confirmed = (await request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).expect(200)).body.data;
    expect(confirmed.state).toBe('confirmed'); expect(evidence.observe).toHaveBeenCalledTimes(2);
  });
  test('lost confirming reservation acknowledgement cannot launch or retry native work', async () => {
    const key = randomUUID(), prepared = await prepare(key); evidence.observe.mockClear(); loseUpdateAck('confirming');
    for (let i = 0; i < 2; i++) expect((await request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).expect(200)).body.data.state).toBe('confirming');
    expect(evidence.observe).not.toHaveBeenCalled();
  });
  test('lost initial insert acknowledgement retains preparing without acquiring a native launch', async () => {
    const original = Confirmation.create.bind(Confirmation), key = randomUUID();
    jest.spyOn(Confirmation, 'create').mockImplementation(async (...args) => { await original(...args); throw new Error('lost claim'); });
    expect((await prepare(key)).state).toBe('preparing'); expect(evidence.observe).not.toHaveBeenCalled();
    expect((await prepare(key)).state).toBe('preparing'); expect(await Confirmation.countDocuments()).toBe(1);
  });
  test('source changes block confirmation and never replace prepared evidence', async () => {
    const key = randomUUID(), prepared = await prepare(key); evidence.observe.mockResolvedValue(packet('changed'));
    const reopened = (await request(app).post(`${URL}/${key}/reopen`).send(selection()).expect(200)).body.data;
    expect(reopened).toMatchObject({ state: 'blocked', blockedCode: 'evidence_changed', bindingSha256: prepared.bindingSha256 });
    const result = (await request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).expect(200)).body.data;
    expect(result).toMatchObject({ state: 'blocked', blockedCode: 'evidence_changed', bindingSha256: prepared.bindingSha256 });
    expect(result.preview).toBeUndefined();
    await request(app).post(`${URL}/${key}/confirm`).send(confirmBody(prepared)).expect(200);
    expect(evidence.observe).toHaveBeenCalledTimes(2);
  });
  test('native failures and DB errors never export private errors or claim confirmation', async () => {
    const key = randomUUID(); evidence.observe.mockRejectedValue(new Error('private DB address and body'));
    const result = await prepare(key); expect(result).toMatchObject({ state: 'blocked', blockedCode: 'evidence_unavailable', bindingSha256: null });
    expect(JSON.stringify(result)).not.toContain('private DB');
    jest.spyOn(Confirmation, 'findById').mockImplementation(() => { throw new Error('private DB address'); });
    const failed = await request(app).get(`${URL}/${key}`).expect(503);
    expect(JSON.stringify(failed.body)).not.toContain('private DB');
  });
  test('transient reopen failure retains the prepared binding without declaring sources changed', async () => {
    const key = randomUUID(), prepared = await prepare(key);
    evidence.observe.mockRejectedValue(Object.assign(new Error('synthetic unavailable native read'), { statusCode: 503 }));
    await request(app).post(`${URL}/${key}/reopen`).send(selection()).expect(503);
    const retained = (await request(app).get(`${URL}/${key}`).expect(200)).body.data;
    expect(retained).toMatchObject({ state: 'prepared', bindingSha256: prepared.bindingSha256, blockedCode: null });
    expect(retained.preview).toBeUndefined(); expect(retained.confirmedAt).toBeNull();
  });
  test('late display privacy failure withholds the preview even after preparation persisted', async () => {
    const key = randomUUID(); evidence.assertCurrent.mockRejectedValue(contract.changed());
    await request(app).post(URL).send({ requestId: key, ...selection() }).expect(409);
    const original = (await request(app).get(`${URL}/${key}`).expect(200)).body.data;
    expect(original.state).toBe('prepared'); expect(original.preview).toBeUndefined();
    await request(app).post(`${URL}/${key}/reopen`).send(selection()).expect(409);
  });
  test('same request cannot change selection, cutoff or displayed binding', async () => {
    const key = randomUUID(), prepared = await prepare(key);
    await request(app).post(URL).send({ requestId: key, ...selection(), before: '2025-01-01T00:00:00.000Z' }).expect(409);
    await request(app).post(`${URL}/${key}/confirm`).send({ ...confirmBody(prepared), bindingSha256: 'f'.repeat(64) }).expect(409);
    expect(evidence.observe).toHaveBeenCalledTimes(1);
  });
  test('coercible bindings and malformed stored confirmation cannot become a receipt', async () => {
    const key = randomUUID(), prepared = await prepare(key);
    await request(app).post(`${URL}/${key}/confirm`).send({ ...confirmBody(prepared), bindingSha256: [prepared.bindingSha256] }).expect(400);
    await Confirmation.collection.updateOne({ _id: digest(key) }, { $set: { state: 'confirmed', confirmedAt: null } });
    await request(app).get(`${URL}/${key}`).expect(503);
    expect(evidence.observe).toHaveBeenCalledTimes(1);
  });
  test.each(['actor', 'authenticatedPerson', 'approvalBound', 'executionAllowed', 'snapshot', 'audience'])('forged %s is rejected before preparation', async field => {
    await request(app).post(URL).send({ requestId: randomUUID(), ...selection(), [field]: 'owner' }).expect(400);
    expect(await Confirmation.countDocuments()).toBe(0); expect(evidence.observe).not.toHaveBeenCalled();
  });
  test('server-selected family scope refuses every operation before storage or native access', async () => {
    const family = mount('family'), key = randomUUID();
    await request(family).post(URL).send({ requestId: key, ...selection() }).expect(403);
    await request(family).get(`${URL}/${key}`).expect(403);
    await request(family).post(`${URL}/${key}/reopen`).send(selection()).expect(403);
    await request(family).post(`${URL}/${key}/confirm`).send({ ...selection(), bindingSha256: 'e'.repeat(64), confirmation: 'reviewed_selected_manifest' }).expect(403);
    expect(await Confirmation.countDocuments()).toBe(0); expect(evidence.observe).not.toHaveBeenCalled();
  });
});

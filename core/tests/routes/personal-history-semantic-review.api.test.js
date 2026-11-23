'use strict';
const express = require('express'), request = require('supertest');
const { randomUUID } = require('node:crypto');
const Review = require('../../models/PersonalHistorySemanticReview');
const current = require('../../src/services/personalHistoryManifestConfirmationCurrent');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const BASE = '/api/secretary/history';
const selected = () => ({ checks: [{ entryId: 'a'.repeat(24), requestId: randomUUID(), snapshotHash: 'b'.repeat(64),
  source: { system: 'gmail', messageId: '1234567890abcdef', threadId: '2234567890abcdef', sourceSha256: 'c'.repeat(64) } }], before: '2026-01-01T00:00:00.000Z' });
const mount = (audience = 'owner') => {
  const app = express(), router = express.Router(); app.use(express.json());
  registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience }, preservationDeps: { audience }, mailboxScopeDeps: { audience },
    envelope: (res, data) => res.json({ ok: true, data }), fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
  app.use('/api/secretary', router); return app;
};
describe('human semantic review keeps the existing owner boundary and strict native fields', () => {
  afterEach(() => jest.restoreAllMocks());
  test('family scope refuses every new action before native storage or evidence, even with claimed owner headers', async () => {
    const get = jest.spyOn(Review, 'findById'), create = jest.spyOn(Review, 'create'), read = jest.spyOn(current, 'observeWithEvidence');
    const app = mount('family'), id = randomUUID();
    for (const path of [`manifest-confirmations/${id}/semantic-reviews`, `manifest-confirmations/${id}/semantic-acceptance`, ...['reopen', 'read', 'decide'].map(action => `semantic-reviews/${id}/${action}`)]) {
      await request(app).post(`${BASE}/${path}`).set('x-service-caller', 'owner').send({ ...selected(), requestId: randomUUID(), audience: 'owner' }).expect(403);
    }
    await request(app).get(`${BASE}/semantic-reviews/${id}`).expect(403);
    expect(get).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  test('caller proof/actor/progress or malformed fields refuse before storage; no previews or secrets in errors', async () => {
    const get = jest.spyOn(Review, 'findById'), create = jest.spyOn(Review, 'create'), app = mount(), id = randomUUID();
    for (const key of ['actor', 'audience', 'semanticAcceptance', 'snapshot', 'coverage', 'host', 'path', 'grant']) {
      await request(app).post(`${BASE}/manifest-confirmations/${id}/semantic-reviews`).send({ ...selected(), requestId: randomUUID(), [key]: 'forged' }).expect(400);
      await request(app).post(`${BASE}/semantic-reviews/${id}/decide`).send({ ...selected(), manifestRequestId: randomUUID(), bindingSha256: 'a'.repeat(64), decision: 'accepted_selected_semantics', [key]: 'forged' }).expect(400);
    }
    for (const value of [-1, 0.5, '0', true, null]) await request(app).post(`${BASE}/semantic-reviews/${id}/read`).send({ ...selected(), manifestRequestId: randomUUID(), source: value, resource: 0, offset: 0 }).expect(400);
    await request(app).post(`${BASE}/semantic-reviews/${id}/decide`).send({ ...selected(), manifestRequestId: randomUUID(), bindingSha256: 'a'.repeat(64), decision: 'reviewed_selected_manifest' }).expect(400);
    expect(get).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  test('unknown original identity stays unknown and the read-only acceptance cannot create a review', async () => {
    const app = mount(), id = randomUUID(), create = jest.spyOn(Review, 'create');
    const result = await request(app).get(`${BASE}/semantic-reviews/${id}`).expect(404);
    expect(result.headers['cache-control']).toBe('private, no-store'); expect(result.body.data).toBeUndefined();
    await request(app).post(`${BASE}/manifest-confirmations/${randomUUID()}/semantic-acceptance`).send({ ...selected(), semanticRequestId: id, observationId: randomUUID() }).expect(404);
    expect(create).not.toHaveBeenCalled();
  });
});

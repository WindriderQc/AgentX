'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const current = require('../../src/services/personalHistoryManifestConfirmationCurrent');
const Confirmation = require('../../models/PersonalHistoryManifestConfirmation');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const BASE = '/api/secretary/history/manifest-confirmations';
const selected = () => ({ checks: [{ entryId: 'a'.repeat(24), requestId: randomUUID(), snapshotHash: 'b'.repeat(64),
  source: { system: 'gmail', messageId: '1234567890abcdef', threadId: '2234567890abcdef', sourceSha256: 'c'.repeat(64) } }],
before: '2026-01-01T00:00:00.000Z', observationId: randomUUID() });
const mount = (audience = 'owner') => {
  const app = express(), router = express.Router(); app.use(express.json());
  registerSecretaryHistoryRoutes({ router, findingScopeDeps: { audience }, preservationDeps: { audience }, mailboxScopeDeps: { audience },
    envelope: (res, data) => res.json({ ok: true, data }),
    fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
  app.use('/api/secretary', router); return app;
};
describe('decision acceptance native observation boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  test('family scope refuses even forged owner headers before receipt storage or native reads', async () => {
    const read = jest.spyOn(Confirmation, 'findById'), native = jest.spyOn(current, 'observeWithEvidence');
    await request(mount('family')).post(`${BASE}/${randomUUID()}/decision-acceptance`).set('x-service-caller', 'owner').send(selected()).expect(403);
    expect(read).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  });
  test('caller outcomes, authority and malformed expectations refuse before native reads', async () => {
    const native = jest.spyOn(current, 'observeWithEvidence');
    for (const field of ['actor', 'snapshot', 'accepted', 'decisionReconciliationAccepted', 'audience', 'grant', 'confirmation']) {
      await request(mount()).post(`${BASE}/${randomUUID()}/decision-acceptance`).send({ ...selected(), [field]: true }).expect(400);
    }
    for (const extra of [{ expected: true }, { expectedCurrent: 'wrong' }]) {
      await request(mount()).post(`${BASE}/${randomUUID()}/decision-acceptance`).send({ ...selected(), ...extra }).expect(400);
    }
    expect(native).not.toHaveBeenCalled();
  });
  test('expectations are separated and native failure returns no partial evidence or private error', async () => {
    const native = jest.spyOn(current, 'observeWithEvidence').mockRejectedValue(new Error('Synthetic private native location'));
    const key = randomUUID(), body = { ...selected(), expected: 'd'.repeat(64), expectedCurrent: 'e'.repeat(64) };
    const response = await request(mount()).post(`${BASE}/${key}/decision-acceptance`).send(body).expect(503);
    expect(native).toHaveBeenCalledWith(key, { checks: body.checks, before: body.before, observationId: body.observationId, expected: body.expectedCurrent }, expect.any(Object));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data).toBeUndefined(); expect(response.body.code).toBe('HISTORY_DECISION_ACCEPTANCE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('private native location');
  });
  test('original identity remains mandatory and an unknown receipt is not replaced', async () => {
    const native = jest.spyOn(current, 'observeWithEvidence');
    await request(mount()).post(`${BASE}/bad-identity/decision-acceptance`).send(selected()).expect(400);
    await request(mount()).post(`${BASE}/${randomUUID()}/decision-acceptance`).send(selected()).expect(404);
    expect(native).toHaveBeenCalledTimes(2);
  });
});

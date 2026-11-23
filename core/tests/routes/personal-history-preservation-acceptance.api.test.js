'use strict';
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const decisions = require('../../src/services/personalHistoryDecisionAcceptance');
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
describe('selected native preservation acceptance boundary', () => {
  afterEach(() => jest.restoreAllMocks());
  test('family scope refuses before original receipt or native evidence regardless of caller claims', async () => {
    const receipt = jest.spyOn(Confirmation, 'findById'), read = jest.spyOn(decisions, 'observeWithEvidence');
    await request(mount('family')).post(`${BASE}/${randomUUID()}/preservation-acceptance`).set('x-service-caller', 'owner').send(selected()).expect(403);
    expect(receipt).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  test('outcomes, device attestations, authority and malformed expectations refuse before native reads', async () => {
    const read = jest.spyOn(decisions, 'observeWithEvidence');
    for (const key of ['actor', 'snapshot', 'preservationAccepted', 'physicalIndependenceAccepted', 'devices', 'host', 'audience', 'grant']) {
      await request(mount()).post(`${BASE}/${randomUUID()}/preservation-acceptance`).send({ ...selected(), [key]: 'forged' }).expect(400);
    }
    for (const key of ['expected', 'expectedDecision', 'expectedCurrent', 'expectedStorage']) {
      await request(mount()).post(`${BASE}/${randomUUID()}/preservation-acceptance`).send({ ...selected(), [key]: true }).expect(400);
    }
    expect(read).not.toHaveBeenCalled();
  });
  test('separates child expectations and withholds private errors or partial evidence', async () => {
    const read = jest.spyOn(decisions, 'observeWithEvidence').mockRejectedValue(new Error('Synthetic private host path'));
    const key = randomUUID(), body = { ...selected(), expected: 'd'.repeat(64), expectedDecision: 'e'.repeat(64), expectedCurrent: 'f'.repeat(64), expectedStorage: '0'.repeat(64) };
    const response = await request(mount()).post(`${BASE}/${key}/preservation-acceptance`).send(body).expect(503);
    expect(read).toHaveBeenCalledWith(key, { checks: body.checks, before: body.before, observationId: body.observationId,
      expected: body.expectedDecision, expectedCurrent: body.expectedCurrent }, expect.any(Object));
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.data).toBeUndefined(); expect(JSON.stringify(response.body)).not.toContain('private host');
  });
  test('original identity remains mandatory and unknown intent cannot prepare or replace a human receipt', async () => {
    await request(mount()).post(`${BASE}/invalid/preservation-acceptance`).send(selected()).expect(400);
    await request(mount()).post(`${BASE}/${randomUUID()}/preservation-acceptance`).send(selected()).expect(404);
  });
});

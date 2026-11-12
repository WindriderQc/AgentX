'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { archive } = require('../fixtures/historyPreservationArchive');

(process.platform === 'win32' ? describe.skip : describe)('owner HTTP -> native adapter -> actual Python archive probe -> Core receipt', () => {
  let fixture, app, id;
  const url = key => `/api/secretary/history/${id}/preservation${key ? '/' + key : ''}`;
  beforeAll(async () => { await Entry.createCollection(); await Entry.createIndexes(); await Suppression.createCollection(); });
  beforeEach(async () => {
    await Entry.deleteMany({}); await Suppression.deleteMany({}); fixture = await archive();
    id = (await history.record({ kind: 'fact', text: 'Synthetic native preservation source', sourceDate: '2024-01-01T00:00:00Z', source: fixture.source })).entry.id;
    app = express(); app.use(express.json()); const router = express.Router();
    registerSecretaryHistoryRoutes({ router, preservationDeps: { audience: 'owner', control: fixture.control },
      envelope: (res, data) => res.json({ ok: true, data }),
      fail: (res, status, message, code) => res.status(status).json({ ok: false, message, code }) });
    app.use('/api/secretary', router);
  });
  afterEach(async () => fixture.cleanup());

  test('real MIME and attachment verification yields a revalidatable immutable exact-message receipt', async () => {
    const key = randomUUID();
    const first = (await request(app).post(url()).send({ requestId: key, revision: 0, source: 0 }).expect(200)).body.data.receipt;
    expect(first.snapshot.status).toBe('verified_scope');
    expect(first.snapshot.copies[0].content.attachments).toHaveLength(1);
    expect(first.snapshot.copies[0].content.partsDecoded).toBe(2);
    expect(first.snapshot.reference.messageId).toBe(fixture.source.messageId);
    expect((await request(app).get(url(key)).expect(200)).body.data.receipt.nativeState).toBe('current');
    expect(fixture.calls).toHaveLength(4);
    const stored = await Entry.findById(id).lean(); expect(stored.preservationChecks).toHaveLength(1);
    expect(stored.preservationChecks[0].snapshotHash).toBe(first.snapshotHash);
  });

  test('a real corrupt mirror attachment cannot reuse yesterday’s proof or produce acceptance', async () => {
    const key = randomUUID();
    await request(app).post(url()).send({ requestId: key, revision: 0, source: 0 }).expect(200);
    await fs.writeFile(fixture.attachmentPaths.mirror, 'Corrupted bytes');
    const current = (await request(app).get(url(key)).expect(200)).body.data.receipt;
    expect(current.nativeState).toBe('unknown'); expect(current.executionAllowed).toBe(false);
    const fresh = (await request(app).post(url()).send({ requestId: randomUUID(), revision: 0, source: 0 }).expect(200)).body.data.receipt;
    expect(fresh.snapshot.status).toBe('blocked');
    expect(fresh.snapshot.blockers).toContain('native_copy_unavailable');
    expect(fresh.snapshot.copies[1].code).toBe('SECRETARY_PRESERVATION_INTEGRITY');
  });

  test('two native archive paths with the same actual machine identity remain blocked', async () => {
    await fs.copyFile(fixture.machines.primary, fixture.machines.mirror);
    const result = (await request(app).post(url()).send({ requestId: randomUUID(), revision: 0, source: 0 }).expect(200)).body.data.receipt;
    expect(result.snapshot.status).toBe('blocked'); expect(result.snapshot.blockers).toContain('native_copies_on_same_machine');
  });

  test.each([
    [['Content-Transfer-Encoding: quoted-printable'], 'private='],
    [['Content-Transfer-Encoding: x-unknown'], 'aGVsbG8='],
    [['Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: quoted-printable'], 'aGVsbG8='],
  ])('a real ambiguous or lossy MIME decode cannot be certified (%j)', async (headers, body) => {
    await fixture.rewriteRaw(Buffer.from(['Message-ID: <preservation@example.invalid>', 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=us-ascii', ...headers, '', body].join('\r\n')));
    id = (await history.record({ kind: 'fact', text: 'Synthetic source with invalid MIME encoding',
      sourceDate: '2024-01-01T00:00:00Z', source: fixture.source })).entry.id;
    const result = (await request(app).post(url()).send({ requestId: randomUUID(), revision: 0, source: 0 }).expect(200)).body.data.receipt;
    expect(result.snapshot.status).toBe('blocked');
    expect(result.snapshot.copies.every(copy => copy.status === 'unavailable')).toBe(true);
  });
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const OwnerStatement = require('../../models/OwnerStatement');
const FinanceTransaction = require('../../models/FinanceTransaction');
const FinanceStatement = require('../../models/FinanceStatement');
const Conversation = require('../../models/Conversation');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { createOwnerSources, digest } = require('../../src/services/ownerSourceService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { registerSecretarySourceRoutes } = require('../../surfaces/household/secretary-sources');

const sha = value => createHash('sha256').update(value).digest('hex');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-sources-'));
const photos = path.join(base, 'photos'), documents = path.join(base, 'documents');
fs.mkdirSync(path.join(photos, 'Pictures', '2014 synthetic trip'), { recursive: true });
fs.mkdirSync(path.join(documents, 'Perso'), { recursive: true });
fs.writeFileSync(path.join(photos, 'Pictures', '2014 synthetic trip', 'beach.jpg'), 'synthetic jpeg');
fs.writeFileSync(path.join(photos, 'Pictures', '2014 synthetic trip', 'notes.txt'), 'not an image');
fs.writeFileSync(path.join(documents, 'Perso', 'contract.pdf'), '%PDF synthetic');
fs.writeFileSync(path.join(base, 'outside.pdf'), 'outside the root');
const sources = createOwnerSources({ env: { OWNER_PHOTOS_DIR: photos, OWNER_DOCUMENTS_MOUNT: documents }, seal: async text => text });

const app = express();
app.use(express.json());
const router = express.Router();
const deps = { router, envelope: (res, data) => res.json({ status: 'success', data }),
  fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) };
registerSecretaryHistoryRoutes(deps);
registerSecretarySourceRoutes({ ...deps, sources });
app.use('/api/secretary', router);

const finding = 'f'.repeat(64);
const entry = (source, n = 1) => ({ kind: 'fact', text: `Synthetic moment ${n}`, sourceDate: '2014-06-02T10:00:00-04:00', source: { findingId: finding, ...source } });

describe('owner sources: statements, Core records and household files', () => {
  beforeAll(async () => {
    for (const model of [Entry, MemoryNote, OwnerStatement, FinanceTransaction, FinanceStatement, Conversation, Suppression]) { await model.createCollection(); await model.createIndexes(); }
  });
  beforeEach(async () => { for (const model of [Entry, MemoryNote, OwnerStatement, FinanceTransaction, FinanceStatement, Conversation, Suppression]) await model.deleteMany({}); });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  test('a statement is kept once, read back, and cited by the hash of its words', async () => {
    const text = 'I lived on a synthetic street until I was eleven.';
    const kept = await request(app).post('/api/secretary/statements').send({ statements: [{ text, label: 'Synthetic answer', receivedOn: '2026-10-15',
      chapter: { title: 'Synthetic chapter', items: ['a'] } }] }).expect(200);
    expect(kept.body.data.results).toEqual([{ sha256: sha(text), created: true, status: 'active' }]);
    const again = await request(app).post('/api/secretary/statements').send({ statements: [{ text }] }).expect(200);
    expect(again.body.data.results[0].created).toBe(false);
    expect((await request(app).get('/api/secretary/statements').expect(200)).body.data.statements[0]).toMatchObject({ label: 'Synthetic answer', chapter: { title: 'Synthetic chapter' } });
    const imported = await request(app).post('/api/secretary/history/import')
      .send({ entries: [entry({ system: 'owner-statement', sourceSha256: sha(text) })] }).expect(200);
    const saved = imported.body.data.results[0].entry;
    expect(saved.sourceUrl).toBe(`/api/secretary/sources/read?system=owner-statement&sha256=${sha(text)}`);
    expect((await request(app).get(saved.sourceUrl).expect(200)).body.data).toMatchObject({ kind: 'testimony', text, date: '2026-10-15' });
    await request(app).post('/api/secretary/statements').send({ statements: [{ text: '' }] }).expect(400);
  });

  test('a ledger line and a conversation message are cited where Core holds them', async () => {
    const statement = await FinanceStatement.create({ fileName: 'synthetic.pdf', fileSha256: 'e'.repeat(64), status: 'reconciled', issuer: 'Synthetic bank', accounts: [] });
    const line = await FinanceTransaction.create({ statementId: statement._id, accountKey: 'synthetic', accountCode: '1000', date: '2023-04-06',
      description: 'Synthetic lodging', amountCents: -12345, fingerprint: 'x', occurrence: 0 });
    const locator = `finance_transactions/${line._id}`;
    const imported = await request(app).post('/api/secretary/history/import')
      .send({ entries: [entry({ system: 'core-record', locator, sourceSha256: digest(`core-record:${locator}`) })] }).expect(200);
    const read = await request(app).get(imported.body.data.results[0].entry.sourceUrl).expect(200);
    expect(read.body.data).toMatchObject({ kind: 'ledger', title: 'Synthetic lodging', date: '2023-04-06', statement: { issuer: 'Synthetic bank' } });
    expect(read.body.data.text).toContain('-123.45');
    await request(app).post('/api/secretary/history/import')
      .send({ entries: [entry({ system: 'core-record', locator, sourceSha256: 'a'.repeat(64) }, 2)] }).expect(400);
    await request(app).post('/api/secretary/history/import')
      .send({ entries: [entry({ system: 'core-record', locator: 'users/0123456789abcdef01234567', sourceSha256: digest('core-record:users/0123456789abcdef01234567') }, 3)] }).expect(400);
    const conversation = await Conversation.create({ title: 'Synthetic chat', messages: [{ role: 'user', content: 'Synthetic words about a move' }] });
    const message = `conversations/${conversation._id}/messages/${conversation.messages[0]._id}`;
    const said = await sources.read({ system: 'core-record', locator: message, sha256: digest(`core-record:${message}`) });
    expect(said).toMatchObject({ kind: 'conversation', title: 'Synthetic chat', text: 'Synthetic words about a move', role: 'user' });
  });

  test('a document is served only while its content matches the cited hash, and only inside its root', async () => {
    const locator = 'documents:Perso/contract.pdf', hash = sha('%PDF synthetic');
    const imported = await request(app).post('/api/secretary/history/import')
      .send({ entries: [entry({ system: 'owner-file', locator, sourceSha256: hash })] }).expect(200);
    const read = (await request(app).get(imported.body.data.results[0].entry.sourceUrl).expect(200)).body.data;
    expect(read).toMatchObject({ kind: 'document', title: 'contract.pdf', type: 'application/pdf' });
    const file = await request(app).get(read.url).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(/^inline/);
    await request(app).get(`/api/secretary/sources/file?locator=${encodeURIComponent(locator)}&sha256=${'b'.repeat(64)}`).expect(404);
    for (const bad of ['documents:../outside.pdf', 'documents:/etc/passwd', 'videos:x.mp4']) {
      await request(app).post('/api/secretary/history/import').send({ entries: [entry({ system: 'owner-file', locator: bad, sourceSha256: hash }, 4)] }).expect(400);
    }
    fs.writeFileSync(path.join(documents, 'Perso', 'contract.pdf'), '%PDF changed');
    await request(app).get(read.url).expect(404);
    fs.writeFileSync(path.join(documents, 'Perso', 'contract.pdf'), '%PDF synthetic');
  });

  test('a photo folder lists only its images and serves them', async () => {
    const locator = 'photos:Pictures/2014 synthetic trip';
    const read = (await request(app).get(`/api/secretary/sources/read?system=owner-file&locator=${encodeURIComponent(locator)}&sha256=${digest(`owner-file:${locator}`)}`).expect(200)).body.data;
    expect(read).toMatchObject({ kind: 'folder', title: '2014 synthetic trip' });
    expect(read.images.map(image => image.name)).toEqual(['beach.jpg']);
    const image = await request(app).get(read.images[0].url).expect(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    await request(app).get(read.images[0].url.replace('beach.jpg', '..%2Foutside.pdf')).expect(404);
    await request(app).get(`/api/secretary/sources/read?system=owner-file&locator=${encodeURIComponent(locator)}&sha256=${'c'.repeat(64)}`).expect(404);
  });

  test('the timeline reads every entry once, and a kept souvenir cites the non-mail sources', async () => {
    const text = 'A synthetic answer.';
    await sources.keepStatements([{ text }]);
    const { entry: saved } = await history.record(entry({ system: 'owner-statement', sourceSha256: sha(text) }));
    await history.record(entry({ system: 'gmail', threadId: 'thread0001', messageId: 'message0001', sourceSha256: 'd'.repeat(64) }, 2));
    const kept = await history.keepAsSouvenir(saved.id, { revision: 0 });
    const note = await MemoryNote.findById(kept.souvenirNoteId).lean();
    expect(note.sourceRefs).toEqual([{ system: 'personal-history', id: saved.id }, { system: 'owner-statement', id: sha(text) }]);
    const timeline = (await request(app).get('/api/secretary/history/timeline').expect(200)).body.data;
    expect(timeline).toMatchObject({ total: 2, truncated: false });
    expect(timeline.entries.find(e => e.id === saved.id).souvenir).toMatchObject({ id: kept.souvenirNoteId });
  });
});

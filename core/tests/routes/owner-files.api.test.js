'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { createOwnerFiles, folderHash } = require('../../src/services/ownerFileService');
const { registerSecretaryHistoryRoutes } = require('../../surfaces/household/secretary-history');
const { registerSecretaryFileRoutes } = require('../../surfaces/household/secretary-files');

const sha = value => createHash('sha256').update(value).digest('hex');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-files-'));
const photos = path.join(base, 'photos'), documents = path.join(base, 'documents');
fs.mkdirSync(path.join(photos, 'Pictures', '2014 synthetic trip'), { recursive: true });
fs.mkdirSync(path.join(documents, 'Perso'), { recursive: true });
fs.writeFileSync(path.join(photos, 'Pictures', '2014 synthetic trip', 'beach.jpg'), 'synthetic jpeg');
fs.writeFileSync(path.join(photos, 'Pictures', '2014 synthetic trip', 'notes.txt'), 'not an image');
fs.writeFileSync(path.join(documents, 'Perso', 'contract.pdf'), '%PDF synthetic');
fs.writeFileSync(path.join(base, 'outside.pdf'), 'outside the root');

const app = express();
app.use(express.json());
const router = express.Router();
const deps = { router, envelope: (res, data) => res.json({ status: 'success', data }),
  fail: (res, status, message, code) => res.status(status).json({ status: 'error', code, message }) };
registerSecretaryHistoryRoutes(deps);
registerSecretaryFileRoutes({ ...deps, files: createOwnerFiles({ env: { OWNER_PHOTOS_DIR: photos, OWNER_DOCUMENTS_MOUNT: documents, OWNER_PHOTOS_HOST_DIR: '/Host/images', OWNER_DOCUMENTS_HOST_DIR: '/Host/datalake/' },
  resize: async (file, width) => { resized.push(width); return Buffer.from(`thumb-${width}`); } }) });
app.use('/api/secretary', router);
const resized = [];
const read = (locator, hash) => request(app).get(`/api/secretary/files/read?locator=${encodeURIComponent(locator)}&sha256=${hash}`);

describe('household files the owner history points to', () => {
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  test('a document is served only while it matches its hash, and only inside its root', async () => {
    const locator = 'documents:Perso/contract.pdf', hash = sha('%PDF synthetic');
    const found = (await read(locator, hash).expect(200)).body.data;
    expect(found).toMatchObject({ kind: 'document', title: 'contract.pdf', type: 'application/pdf' });
    const file = await request(app).get(found.url).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(/^inline/);
    await read(locator, 'b'.repeat(64)).expect(404);
    for (const bad of ['documents:../outside.pdf', 'documents:/etc/passwd', 'videos:x.mp4', 'documents:Perso/../../outside.pdf']) {
      await read(bad, sha('outside the root')).expect(404);
    }
    fs.writeFileSync(path.join(documents, 'Perso', 'contract.pdf'), '%PDF changed');
    await request(app).get(found.url).expect(404);
    fs.writeFileSync(path.join(documents, 'Perso', 'contract.pdf'), '%PDF synthetic');
  });

  test('a photo folder lists only its images and serves them', async () => {
    const locator = 'photos:Pictures/2014 synthetic trip';
    const found = (await read(locator, folderHash(locator)).expect(200)).body.data;
    expect(found).toMatchObject({ kind: 'folder', title: '2014 synthetic trip' });
    expect(found.images.map(image => image.name)).toEqual(['beach.jpg']);
    expect((await request(app).get(found.images[0].url).expect(200)).headers['content-type']).toBe('image/jpeg');
    await request(app).get(found.images[0].url.replace('beach.jpg', '..%2F..%2Foutside.pdf')).expect(404);
    await request(app).get(found.images[0].url.replace('beach.jpg', 'notes.txt')).expect(404);
    await read(locator, 'c'.repeat(64)).expect(404);
  });

  test('an image is downsized on request, verified first and cached; other widths and files are served as they are', async () => {
    fs.writeFileSync(path.join(photos, 'Pictures', 'single.jpg'), 'synthetic single');
    const url = width => `/api/secretary/files/content?locator=${encodeURIComponent('photos:Pictures/single.jpg')}&sha256=${sha('synthetic single')}${width ? `&width=${width}` : ''}`;
    const small = await request(app).get(url(480)).expect(200);
    expect(small.headers['content-type']).toBe('image/jpeg');
    expect(small.body.toString()).toBe('thumb-480');
    await request(app).get(url(480)).expect(200);
    expect(resized).toEqual([480]);
    expect((await request(app).get(url(333)).expect(200)).body.toString()).toBe('synthetic single');
    await request(app).get(url(480).replace(sha('synthetic single'), 'a'.repeat(64))).expect(404);
    const pdf = `/api/secretary/files/content?locator=${encodeURIComponent('documents:Perso/contract.pdf')}&sha256=${sha('%PDF synthetic')}&width=480`;
    expect((await request(app).get(pdf).expect(200)).headers['content-type']).toBe('application/pdf');
    expect(resized).toEqual([480]);
  });

  test('a host path recorded by a history context opens the same file or folder', async () => {
    const byPath = (nativePath, hash = '') => request(app).get(`/api/secretary/files/read?nativePath=${encodeURIComponent(nativePath)}&sha256=${hash}`);
    expect((await byPath('/Host/datalake/Perso/contract.pdf', sha('%PDF synthetic')).expect(200)).body.data.kind).toBe('document');
    await byPath('/Host/datalake/Perso/contract.pdf').expect(404);
    expect((await byPath('/Host/images/Pictures/2014 synthetic trip').expect(200)).body.data.images).toHaveLength(1);
    await byPath('/Elsewhere/Perso/contract.pdf', sha('%PDF synthetic')).expect(404);
    await byPath('/Host/datalake/../outside.pdf', sha('outside the root')).expect(404);
  });
});

describe('the timeline read', () => {
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => { for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({}); });

  test('returns every remembered entry once, with its kept souvenir and without forgotten ones', async () => {
    const entry = n => ({ kind: 'fact', text: `Synthetic moment ${n}`, sourceDate: '2014-06-02T10:00:00-04:00',
      source: { system: 'gmail', threadId: 'thread0001', messageId: `message000${n}`, sourceSha256: String(n).repeat(64), findingId: 'f'.repeat(64) } });
    const first = (await history.record(entry(1))).entry, second = (await history.record(entry(2))).entry;
    await history.record(entry(3));
    const kept = await history.keepAsSouvenir(first.id, { revision: 0 });
    await history.review(second.id, { state: 'forgotten', revision: 0 });
    const timeline = (await request(app).get('/api/secretary/history/timeline').expect(200)).body.data;
    expect(timeline).toMatchObject({ total: 2, truncated: false });
    expect(timeline.entries.map(e => e.text)).toEqual(['Synthetic moment 1', 'Synthetic moment 3']);
    expect(timeline.entries[0].souvenir).toMatchObject({ id: kept.souvenirNoteId });
  });
});

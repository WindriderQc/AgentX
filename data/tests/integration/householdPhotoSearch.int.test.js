'use strict';

// Synthetic inventory producers → real Mongo/browse → Household resolver and
// configured read-only serving boundary. No library, model or live collector.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { MongoClient } = require('mongodb');
const { Scanner } = require('../../services/scanner');
const { createVisuals } = require('../../../core/surfaces/household/visuals');

jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const URI = process.env.MONGODB_URI_TEST;
const BASE_DB = URI ? new URL(URI).pathname.slice(1) : '';
if (!URI || !BASE_DB.startsWith('agentx_data_test_')) throw new Error('Use the disposable Data test launcher.');

describe('Household photo search across inventory and serving', () => {
  let client, db, base, root, app;
  const album = 'Camping (Rivière)';
  const relative = `${album}/IMG_0001.JPG`;
  const bytes = Buffer.from('synthetic-image-bytes');

  beforeAll(async () => {
    client = await new MongoClient(URI).connect();
    db = client.db(`${BASE_DB}_photos`);
  });
  afterAll(async () => {
    try { if (db) await db.dropDatabase(); }
    finally { if (client) await client.close(); }
  });
  beforeEach(async () => {
    for (const name of ['nas_files', 'nas_scans', 'nas_directories']) await db.collection(name).deleteMany({});
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-search-'));
    root = path.join(base, 'photos');
    fs.mkdirSync(path.join(root, album), { recursive: true });
    fs.writeFileSync(path.join(root, relative), bytes);
    fs.utimesSync(path.join(root, relative), 1700000000, 1700000000);
    for (let i = 0; i < 25; i++) {
      const video = path.join(root, album, `video-${i}.mov`);
      fs.writeFileSync(video, 'synthetic-video');
      fs.utimesSync(video, 1800000000, 1800000000);
    }
    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use('/api/v1/storage', require('../../routes/storage.routes'));
    app.use(require('../../middleware/errorHandler'));
  });
  afterEach(() => { if (base) fs.rmSync(base, { recursive: true, force: true }); });

  test.each(['scanner', 'external batch'])('%s: videos do not hide an older photo in the same album', async producer => {
    if (producer === 'scanner') {
      await new Scanner(db).run({ roots: [root], scanId: 'synthetic-scan', hashMode: 'none' });
    } else {
      await db.collection('nas_scans').insertOne({
        _id: 'synthetic-scan', status: 'running', config: { external: true, roots: [root] }
      });
      await request(app).post('/api/v1/storage/scan/synthetic-scan/batch').send({ files:
        fs.readdirSync(path.join(root, album)).map(filename => {
          const file = path.join(root, album, filename), stat = fs.statSync(file);
          return { path: file, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
        })
      }).expect(200);
    }

    // The existing broad query fills its entire window with newer videos.
    const old = await request(app).get('/api/v1/storage/files/browse').query({
      root, category: 'media', search: album, includeDirname: 'true', limit: 25
    }).expect(200);
    expect(old.body.data.files).toHaveLength(25);
    expect(old.body.data.files.every(file => file.ext === 'mov')).toBe(true);

    // A sibling root with a better-ranked image must never enter this result.
    await db.collection('nas_files').insertOne({ path: `${root}-private/${album}/secret.jpg`,
      dirname: `${root}-private/${album}`, filename: 'secret.jpg', category: 'media', ext: 'jpg',
      size: 999999, mtime: 1900000000 });
    const calls = [];
    const env = {
      HOUSEHOLD_IMAGE_ROOTS_JSON: JSON.stringify({ photos: root }),
      HOUSEHOLD_IMAGE_MOUNT_BASE: base, HOUSEHOLD_IMAGE_FAMILY_SOURCES: 'photos'
    };
    const visuals = createVisuals({ env, dataFetch: async (route, { query }) => {
      calls.push(new URLSearchParams(query));
      const result = await request(app).get(route).query(Object.fromEntries(new URLSearchParams(query))).expect(200);
      return { response: { ok: true }, body: result.body };
    } });
    visuals.register(app);
    const block = { kind: 'image', source: 'photos', body: album };
    await visuals.present(block, { family: true });
    expect(block.status).toBe('found');
    expect(calls).toHaveLength(1);
    expect(calls[0].get('limit')).toBe('25');
    const imagePath = new URL(block.image.url, 'http://localhost').search;
    const served = await request(app).get(`/family/visuals/file${imagePath}`).expect(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.body).toEqual(bytes);
    expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);

    for (const file of ['../secret.jpg', `${album}/video-0.mov`, '/etc/passwd.jpg']) {
      await request(app).get('/family/visuals/file').query({ source: 'photos', path: file }).expect(404);
    }
    fs.writeFileSync(path.join(base, 'secret.jpg'), 'private synthetic bytes');
    fs.symlinkSync(path.join(base, 'secret.jpg'), path.join(root, 'escape.jpg'));
    await request(app).get('/family/visuals/file').query({ source: 'photos', path: 'escape.jpg' }).expect(404);

    env.HOUSEHOLD_IMAGE_FAMILY_SOURCES = 'web';
    await request(app).get(`/family/visuals/file${imagePath}`).expect(404);
    await request(app).get(`/private/visuals/file${imagePath}`).expect(200);
    const denied = { kind: 'image', source: 'photos', body: album };
    await visuals.present(denied, { family: true });
    expect(denied.status).toBe('missing');
    expect(calls).toHaveLength(1);
  });
});

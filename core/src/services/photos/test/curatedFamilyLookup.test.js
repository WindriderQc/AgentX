'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhotoFrameService } = require('../photoFrameService');
const uuid = n => '10000000-0000-0000-0000-00000000000' + n;
const photo = (id, fields) => ({
  id, type: 'IMAGE', visibility: 'timeline', isOffline: false, isTrashed: false, libraryId: uuid(2), originalFileName: 'renard.jpg',
  originalPath: '/fake/frame/renard.jpg', tags: [], ...fields
});

function fixture() {
  const state = { config: { source: 'directory-and-album', prefix: '/fake/frame', albumId: uuid(8),
    conversationLookup: { enabled: true, albumId: uuid(1) } },
    row: photo(uuid(4)), privateLibraryId: uuid(3), album: new Set([uuid(4)]), calls: [], images: [] };
  const frame = createPhotoFrameService({
    config: () => state.config, processingConfig: () => ({ libraryId: state.privateLibraryId }),
    client: { settings: () => ({ enabled: true }),
      async json(route, { body } = {}) {
        if (route.startsWith('/assets/')) return state.directRow || state.row;
        if (route === '/search/random') { state.frameFilter = body.filter; return state.row ? [state.row] : []; }
        assert.equal(route, '/search/metadata'); assert.equal(body.size, 1);
        const q = body.filter;
        const { row } = state;
        state.calls.push(q);
        if (q.id && !state.album.has(q.id.eq)) return { assets: { items: [] } };
        return { assets: { items: row ? [row] : [] } };
      },
      async image(route) { state.images.push(route); return { bytes: Buffer.from('fake jpg') }; }
    }
  });
  return { state, frame };
}

test('search and delivery keep curated scope and suppress private ingest, pending and unrelated candidates', async () => {
  const { state, frame } = fixture();
  assert.equal((await frame.lookup('renard')).id, uuid(4));
  assert.equal((await frame.lookupImage(uuid(4))).bytes.toString(), 'fake jpg');
  assert.deepEqual(state.calls[0].albumIds, { any: [uuid(1)] });
  assert.deepEqual(state.calls[0].libraryId, { ne: uuid(3) });
  assert.deepEqual(state.calls[2].albumIds, { any: [uuid(1)] });
  assert.deepEqual(state.calls[2].libraryId, { ne: uuid(3) });
  for (const fields of [{ libraryId: uuid(3) }, { visibility: 'hidden' }, { isTrashed: true }, { isOffline: true }, { tags: [{ value: 'AgentX/Relecture/à relire' }] }, { tags: undefined },
    { tags: [{ value: '  AGENTX/RELECTURE/a   relire  ' }] }, { libraryId: '' }, { libraryId: 'not a UUID' },
    { libraryId: undefined }, { isOffline: undefined }, { isTrashed: undefined },
    { isOffline: 0 }, { isTrashed: 0 }]) {
    state.row = photo(uuid(4), fields);
    assert.equal(await frame.lookup('renard'), null);
    await assert.rejects(frame.lookupImage(uuid(4)), { code: 'PHOTOS_NOT_FOUND' });
  }
  state.row = photo(uuid(5));
  assert.equal(await frame.lookup('renard'), null, 'matching path alone cannot authorize album lookup');
  await assert.rejects(frame.lookupImage(uuid(5)), { code: 'PHOTOS_NOT_FOUND' });
  assert.equal(state.images.length, 1);
});

test('revocation between lookup and rendering fails, and broad or inferred opt-in never queries', async () => {
  const { state, frame } = fixture();
  await frame.lookup('renard');
  state.album.clear();
  await assert.rejects(frame.lookupImage(uuid(4)), { code: 'PHOTOS_NOT_FOUND' });
  assert.equal(state.images.length, 0);
  for (const override of [{ conversationLookup: undefined }, { conversationLookup: { albumId: uuid(1) } },
    { conversationLookup: { enabled: true } }, { conversationLookup: { enabled: false, albumId: uuid(1) } }]) {
    const other = fixture();
    Object.assign(other.state.config, override);
    await assert.rejects(other.frame.lookup('renard'), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
    await assert.rejects(other.frame.lookupImage(uuid(4)), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
    assert.equal(other.state.calls.length, 0);
  }
});

test('the visible reply authorizes only the Family turn and never uses Web or filename in the card', async () => {
  const { reply } = require('../../../../surfaces/household/family-picture-lookup');
  const { familyAlbumTurn } = require('../../../../surfaces/household/family-album-access');
  const { frame, state } = fixture();
  const verified = { tokenHash: 'synthetic-pinned-device' };
  const ask = async (text, device, packId = 'kidx_nestor', scopeId = 'family') => reply({
    text, language: 'fr', turnId: 'synthetic', signal: new AbortController().signal,
    visuals: { sources: () => { throw Error('must not use Web'); } },
    albumAllowed: familyAlbumTurn(device, packId, scopeId), album: () => frame, issueAlbumImage: () => '/api/photos/frame/album/synthetic-receipt/image'
  });
  const question = 'Montre-moi une photo de renard dans nos photos.';
  for (const [device, pack, scope] of [
    [undefined], [{ ...verified, unverified: true }], [{ ...verified, unlockedUntil: new Date() }],
    [verified, 'personal_operator', 'family'], [verified, 'kidx_nestor', 'personal']
  ]) {
    const refused = await ask(question, device, pack, scope);
    assert.match(refused.text, /pas accessible/); assert.deepEqual(refused.display, []);
  }
  assert.match((await ask('Montre-moi une photo de renard dans nos médias.', verified)).text, /pas accessible/);
  assert.equal(state.calls.length, 0);
  const found = await ask(question, verified);
  assert.match(found.text, /trouvé une photo/);
  assert.equal(found.display[0].image.url, '/api/photos/frame/album/synthetic-receipt/image');
  assert.doesNotMatch(JSON.stringify(found.display), /renard|libraryId|\/fake/);
  state.row = null;
  assert.match((await ask(question, verified)).text, /pas trouvé/);
});

test('actual registered album route refuses a guessed scope and delivers only still approved bytes', async () => {
  const Module = require('node:module');
  const load = Module._load;
  const routes = new Map();
  Module._load = function(id, parent) {
    if (parent?.filename?.endsWith('/routes/photos.js')) {
      if (id === 'express') return { Router: () => ({ use() {}, get: (path, fn) => routes.set(path, fn), post() {}, put() {}, delete() {}, patch() {} }) };
      if (id === '../src/services/photos/photoService' || id === '../src/helpers/requestCaller') return {};
    }
    return load.apply(this, arguments);
  };
  const { frame, state } = fixture();
  const { familyAlbumReceipts } = require('../../../../surfaces/household/family-album-receipts');
  let session = { sessionId: 'synthetic-session', status: 'active', scopeId: 'family', packId: 'kidx_nestor' };
  try { require('../../../../routes/photos').createPhotoRoutes({ service: {}, frame, readAlbumSession: async id => id === session.sessionId ? session : null }); }
  finally { Module._load = load; }
  const GET = routes.get('/frame/album/:receipt/image');
  assert.equal(typeof GET, 'function');
  const device = { tokenHash: 'synthetic-one' };
  const url = familyAlbumReceipts.issue(device, session.sessionId, uuid(4));
  const token = url.split('/').at(-2);
  const send = async (familyDevice, receipt = token) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, set() {},
      json(v) { this.payload = v; }, end(v) { this.bytes = v; } };
    await GET({ params: { receipt }, familyDevice }, res);
    return res;
  };
  assert.equal((await send()).statusCode, 404);
  assert.equal((await send({ tokenHash: 'synthetic', unverified: true })).statusCode, 404);
  assert.equal((await send({ tokenHash: 'synthetic-two' })).statusCode, 404);
  session = { ...session, scopeId: 'personal' };
  assert.equal((await send(device)).statusCode, 404);
  session = { ...session, scopeId: 'family' };
  const loaded = await send(device);
  assert.equal(loaded.statusCode, 200); assert.equal(loaded.bytes.toString(), 'fake jpg');
  assert.equal((await send(device, uuid(9))).statusCode, 404);
  state.directRow = photo(uuid(4), { visibility: 'hidden' });
  assert.equal((await send(device)).statusCode, 404, 'stale album index cannot override current visibility');
  state.directRow = null;
  state.album.delete(uuid(4));
  assert.equal((await send(device)).statusCode, 404);
  assert.equal(state.images.length, 1);
});

test('frame keeps both its sources while conversation uses only its separate appointed album', async () => {
  const { state, frame } = fixture();
  assert.equal((await frame.next()).id, uuid(4));
  assert.deepEqual(state.frameFilter.or, [
    { originalPath: { startsWith: '/fake/frame/' } }, { albumIds: { any: [uuid(8)] } }
  ]);
  assert.equal((await frame.lookup('renard')).id, uuid(4));
  assert.equal((await frame.lookupImage(uuid(4))).bytes.toString(), 'fake jpg');
  assert.ok(state.calls.every(filter => !filter.originalPath && !filter.or && filter.albumIds.any[0] === uuid(1)));
  state.config.conversationLookup = { enabled: false, albumId: uuid(1) };
  const calls = state.calls.length;
  await assert.rejects(frame.lookupImage(uuid(4)), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
  assert.equal(state.calls.length, calls);
  assert.equal((await frame.next()).id, uuid(4));
});

test('invalid conversation opt-in in the instance file leaves valid mixed frame settings intact', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { loadFrameConfig } = require('../photoFrameService');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-frame-grant-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config/photo-frame.json');
  const frame = { version: 1, source: 'directory-and-album', originalPathPrefix: '/fake/frame', albumId: uuid(8) };
  for (const grant of [undefined, true, { enabled: true }, { enabled: true, albumId: 'not-a-uuid' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...frame, conversationLookup: grant }));
    const parsed = loadFrameConfig({ AGENTX_INSTANCE_ROOT: root });
    assert.equal(parsed.source, frame.source);
    assert.equal(parsed.albumId, frame.albumId);
    assert.equal(parsed.conversationLookup, undefined);
  }
  fs.writeFileSync(file, JSON.stringify({ ...frame, conversationLookup: { enabled: true, albumId: uuid(1) } }));
  const parsed = loadFrameConfig({ AGENTX_INSTANCE_ROOT: root });
  assert.deepEqual(parsed.conversationLookup, { enabled: true, albumId: uuid(1) });
  assert.equal(parsed.albumId, frame.albumId);
});


test('a missing private-library designation is a closed gate before any provider call', async () => {
  const { state, frame } = fixture();
  state.privateLibraryId = undefined;
  await assert.rejects(frame.lookup('renard'), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
  await assert.rejects(frame.lookupImage(uuid(4)), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
  assert.equal(state.calls.length, 0);
  assert.equal(state.images.length, 0);
});

test('photo receipt expires quickly and cannot be reused by another pinned browser', () => {
  const { createFamilyAlbumReceipts } = require('../../../../surfaces/household/family-album-receipts');
  let now = 100;
  const pool = createFamilyAlbumReceipts({ now: () => now });
  const browser = { tokenHash: 'synthetic-one' };
  const receipt = pool.issue(browser, 'synthetic-session', uuid(4)).split('/').at(-2);
  assert.equal(pool.claim({ tokenHash: 'synthetic-two' }, receipt), null);
  assert.deepEqual(pool.claim(browser, receipt), { sessionId: 'synthetic-session', assetId: uuid(4) });
  now += 120000;
  assert.equal(pool.claim(browser, receipt), null);
});

test('UUIDs compare canonically, excluding private library even when provider varies case', async () => {
  const { state, frame } = fixture();
  const privateId = 'DC5D46C0-7761-49B2-90A9-535CC811E29A';
  state.privateLibraryId = privateId;
  state.row = photo(uuid(4), { libraryId: privateId.toLowerCase() });
  assert.equal(await frame.lookup('renard'), null);
  await assert.rejects(frame.lookupImage(uuid(4)), { code: 'PHOTOS_NOT_FOUND' });
  assert.equal(state.calls[0].libraryId.ne, privateId.toLowerCase());
  state.privateLibraryId = privateId.toLowerCase();
  state.row = photo(uuid(4), { libraryId: privateId });
  assert.equal(await frame.lookup('renard'), null);
  await assert.rejects(frame.lookupImage(uuid(4)), { code: 'PHOTOS_NOT_FOUND' });
  for (const invalid of ['', 'bogus', 42]) {
    state.privateLibraryId = invalid;
    await assert.rejects(frame.lookup('renard'), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
    await assert.rejects(frame.lookupImage(uuid(4)), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
  }
});

test('a stale filename index cannot return a photo no longer matching the lookup', async () => {
  const { state, frame } = fixture();
  state.directRow = photo(uuid(4), { originalFileName: 'hibou.jpg' });
  assert.equal(await frame.lookup('renard'), null);
  assert.equal(state.images.length, 0);
  state.directRow = null;
  assert.equal((await frame.lookup('renard')).id, uuid(4));
});

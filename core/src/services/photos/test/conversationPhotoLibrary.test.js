'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { conversationGrant } = require('../conversationPhotoLibrary');
const { createPhotoFrameService } = require('../photoFrameService');

function fixture() {
  const owner = randomUUID(), other = randomUUID();
  const mine = { id: randomUUID(), ownerId: owner, libraryId: null, type: 'IMAGE', originalFileName: 'Triangle.png',
    isTrashed: false, isOffline: false, visibility: 'archive' };
  const partner = { ...mine, ownerId: other, id: randomUUID() };
  const state = { me: owner, direct: mine, grant: { enabled: true, source: 'owner-library', ownerId: owner },
    queries: [], bytes: [] };
  const frame = createPhotoFrameService({ config: () => ({ conversationLookup: state.grant }),
    processingConfig: () => { throw Error('The independent album workflow must not run'); },
    client: { settings: () => ({ enabled: true }), async json(route, { body } = {}) {
      if (route === '/users/me') return { id: state.me };
      if (route === '/assets/' + mine.id) return state.direct;
      assert.equal(route, '/search/metadata'); state.queries.push(body);
      assert.equal(body.filter.albumIds, undefined);
      assert.equal(body.filter.visibility.in.includes('locked'), false);
      return { assets: { items: body.cursor ? [mine] : [partner], nextCursor: body.cursor ? null : 'second' } };
    }, async image(route) { state.bytes.push(route); return { bytes: Buffer.from('fixture') }; } } });
  return { owner, other, mine, partner, state, frame };
}

test('independent library grant includes an unshared owner upload outside albums; partner rows are skipped', async () => {
  const { state, frame, mine } = fixture();
  assert.deepEqual(await frame.lookup('triangle'), { id: mine.id });
  assert.equal(state.queries.length, 2);
  assert.equal((await frame.lookupImage(mine.id)).bytes.toString(), 'fixture');
  assert.equal(state.bytes.length, 1);
});

test('ownership, account and asset eligibility are rechecked at byte delivery', async () => {
  const { owner, other, mine, state, frame } = fixture();
  for (const invalid of [{ ownerId: other }, { ownerId: null }, { id: randomUUID() }, { isTrashed: true },
    { isOffline: true }, { visibility: 'locked' }, { visibility: undefined }]) {
    state.direct = { ...mine, ...invalid };
    assert.equal(await frame.lookup('triangle'), null);
    await assert.rejects(frame.lookupImage(mine.id), { code: 'PHOTOS_NOT_FOUND' });
  }
  state.direct = mine;
  state.me = other;
  await assert.rejects(frame.lookup('triangle'), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
  await assert.rejects(frame.lookupImage(mine.id), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
  state.me = owner; state.grant.enabled = false;
  await assert.rejects(frame.lookupImage(mine.id), { code: 'PHOTO_FRAME_NOT_CONFIGURED' });
  assert.deepEqual(state.bytes, []);
});

test('neither a bare opt-in nor a mixed owner-and-album grant authorizes a library', () => {
  const ownerId = randomUUID(), albumId = randomUUID();
  for (const grant of [{ enabled: true }, { enabled: true, ownerId }, { enabled: true, source: 'owner-library' },
    { enabled: true, source: 'owner-library', ownerId, albumId }, { enabled: true, source: 'unknown', albumId }]) {
    assert.equal(conversationGrant(grant), null);
  }
  assert.deepEqual(conversationGrant({ enabled: true, albumId }), { enabled: true, albumId });
});

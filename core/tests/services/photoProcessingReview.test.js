'use strict';
const crypto = require('node:crypto');
const Cards = require('../../models/PhotoProcessingCard'), Decisions = require('../../models/PhotoProcessingDecision');
const { createPhotoProcessingReview } = require('../../src/services/photos/photoProcessingReview');
const uuid = () => crypto.randomUUID(), SHA = 'a'.repeat(64);
let selected, client, bridge, immich, config, review;
beforeEach(async () => {
  await Promise.all([Cards, Decisions].map(model => model.deleteMany({})));
  selected = false;
  config = { libraryId: uuid(), originalPathPrefix: '/managed-imports', frameAlbumId: uuid() };
  const asset = { id: uuid(), type: 'IMAGE', visibility: 'timeline' };
  await Cards.create({ _id: SHA, assetId: asset.id, libraryId: config.libraryId, metadata: { type: 'IMAGE', exif: { description: 'Human original' } },
    analysis: { state: 'completed', analysisId: uuid(), card: { proposal: { description: 'Model hypothesis' } } } });
  bridge = { call: jest.fn(async input => input.op === 'projection' ? { sha256: SHA } : { exported: true }) };
  immich = { asset: jest.fn(async () => asset), syncReview: jest.fn() };
  client = { json: jest.fn(async (p, options) => {
    if (p === '/search/metadata') return { assets: { items: selected ? [asset] : [] } };
    selected = options.method === 'PUT'; return [{ id: asset.id, success: true }];
  }) };
  review = createPhotoProcessingReview({ client, bridge, immich, config: () => config, frameConfig: () => ({ albumId: config.frameAlbumId }) });
});
test('owner corrections preserve metadata/model observations and replay one durable portable version', async () => {
  const input = { writeId: uuid(), sha256: SHA, expectedRevision: 0, approved: true, description: 'Owner correction', tags: ['Reviewed'] };
  const result = await review.review(input);
  expect(await review.review(input)).toEqual(result);
  const card = await Cards.findById(SHA).lean();
  expect(card.review).toMatchObject({ revision: 1, description: 'Owner correction', approved: true });
  expect(card.metadata.exif.description).toBe('Human original'); expect(card.analysis.card.proposal.description).toBe('Model hypothesis');
  expect(client.json).not.toHaveBeenCalled(); expect(immich.syncReview).toHaveBeenCalledTimes(1);
  expect(bridge.call.mock.calls.filter(([x]) => x.op === 'exportCard')).toHaveLength(1);
  await expect(review.review({ ...input, tags: ['Different'] })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
});
test('lost album acknowledgement is reconciled through membership with no second album mutation', async () => {
  const send = client.json;
  let lost = true;
  client.json = jest.fn(async (...args) => {
    const result = await send(...args);
    if (args[1]?.method === 'PUT' && lost) { lost = false; throw Error('acknowledgement lost'); }
    return result;
  });
  const input = { writeId: uuid(), sha256: SHA, expectedRevision: 0, selected: true };
  await expect(review.frame(input)).rejects.toThrow('acknowledgement lost');
  expect(selected).toBe(true);
  await expect(review.frame({ ...input, writeId: uuid(), selected: false })).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
  expect(await review.frame(input)).toMatchObject({ revision: 1, selected: true });
  expect(client.json.mock.calls.filter(([, x]) => x.method === 'PUT')).toHaveLength(1);
  expect((await Cards.findById(SHA)).pendingDecision).toBeUndefined();
});
test('export failure retains the exact review identity and resumes after its Mongo update', async () => {
  const input = { writeId: uuid(), sha256: SHA, expectedRevision: 0, approved: true, description: 'A correction', tags: [] };
  const send = bridge.call;
  bridge.call = jest.fn(async input => {
    if (input.op === 'exportCard' && !bridge.lost) { bridge.lost = true; throw Error('export reply lost'); }
    return send(input);
  });
  await expect(review.review(input)).rejects.toThrow('export reply lost');
  expect((await Cards.findById(SHA)).review.writeId).toBe(input.writeId);
  await expect(review.review({ ...input, writeId: uuid(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'REVIEW_CHANGED' });
  expect(await review.review(input)).toMatchObject({ revision: 1, writeId: input.writeId });
  const exports = bridge.call.mock.calls.filter(([x]) => x.op === 'exportCard');
  expect(exports[0][0]).toEqual(exports[1][0]);
});
test('a changed configured album cannot redirect an uncertain original decision', async () => {
  const input = { writeId: uuid(), sha256: SHA, expectedRevision: 0, selected: true };
  client.json.mockRejectedValueOnce(new Error('network unavailable'));
  await expect(review.frame(input)).rejects.toThrow('network unavailable');
  config.frameAlbumId = uuid();
  await expect(review.frame(input)).rejects.toMatchObject({ code: 'PHOTO_PROCESSING_CONFIG_CHANGED' });
  expect(client.json).toHaveBeenCalledTimes(1);
});
test('frame selection requires the freshly checked verified image and leaves phone files outside this service', async () => {
  immich.asset.mockResolvedValue({ id: uuid(), type: 'VIDEO', visibility: 'timeline' });
  await expect(review.frame({ writeId: uuid(), sha256: SHA, expectedRevision: 0, selected: true }))
    .rejects.toMatchObject({ code: 'PHOTO_FRAME_INVALID' });
  expect(client.json).not.toHaveBeenCalled(); expect(selected).toBe(false);
});
test('invalid XML tag text is rejected before reserving a durable human decision',async()=>{
  await expect(review.review({writeId:uuid(),sha256:SHA,expectedRevision:0,approved:true,description:'Review',tags:['bad\u0000tag']}))
    .rejects.toMatchObject({code:'INVALID_PHOTO_TAGS'});
  expect(await Decisions.countDocuments()).toBe(0);expect((await Cards.findById(SHA)).pendingDecision).toBeUndefined();
  expect(immich.syncReview).not.toHaveBeenCalled();
});

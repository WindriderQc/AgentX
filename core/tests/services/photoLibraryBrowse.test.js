'use strict';
const crypto = require('node:crypto');
const express = require('express'), request = require('supertest');
const Cards = require('../../models/PhotoProcessingCard'), Decisions = require('../../models/PhotoProcessingDecision');
const Similarity = require('../../models/PhotoLibrarySimilarity');
const Runtime = require('../../models/RuntimeCoordination');
const control = require('../../src/services/photos/photoProcessingControl');
const { createPhotoLibraryBrowse } = require('../../src/services/photos/photoLibraryBrowse');
const { createPhotoProcessingService } = require('../../src/services/photos/photoProcessingService');
const { registerPhotoProcessing } = require('../../surfaces/diskx/photo-processing');
const { allowedForFamilyDevice } = require('../../surfaces/household/family-device');
const { demoSurfaceDisabled } = require('../../../shared/agentxRuntimeProfile');
const uuid = () => crypto.randomUUID(), sha = n => n.toString(16).padStart(64, '0');
let config, browse;
function fixture(n, extra = {}) {
  return { _id: sha(n), libraryId: config.libraryId, assetId: uuid(), metadata: { type: 'IMAGE', exif: { city: n === 71 ? 'Fixture Bay' : 'Synthetic City' } },
    projection: { relativePath: `demo/image-${n}.jpg`, runId: uuid(), requestId: uuid() },
    analysis: { state: 'completed', analysisId: uuid(), retry: { previousAnalysis: { privateInternalProof: 'never-return' } },
      card: { proposal: { description: n === 71 ? 'Literal [shore].* scene' : `Synthetic image ${n}`, tags: ['nature'], quality: 'bonne',
        frameSuitability: n > 60 ? 'oui' : 'non', privacyReview: n === 71, reasons: [] }, provenance: { createdAt: '2026-01-01T00:00:00Z' } } }, ...extra };
}
beforeEach(async () => {
  await Promise.all([Cards, Decisions, Runtime, Similarity].map(m => m.deleteMany({})));
  config = { libraryId: uuid(), frameAlbumId: uuid() };
  await control.pause({ requestId: uuid(), expectedRevision: 0 }, 'synthetic-owner');
  browse = createPhotoLibraryBrowse({ config: () => config, control });
});
test('filters and counts span imports and pages, deduplicate content and leave durable pause untouched', async () => {
  await Cards.create(Array.from({ length: 73 }, (_, i) => fixture(i+1)));
  await Cards.updateOne({ _id: sha(72) }, { $set: { frame: { revision: 2, selected: true } } });
  await Cards.updateOne({ _id: sha(73) }, { $set: { review: { revision: 1, approved: true } } });
  const before = await Runtime.findById('runtime').lean();
  const all = await browse({}); expect(all.results).toHaveLength(60); expect(all.total).toBe(73);
  expect(all.summary).toEqual({ total: 73, suggested: 11, frame: 1, review: 72, reviewed: 1, privacy: 1 });
  const suggested = await browse({ filter: 'suggested', limit: 3 });
  expect(suggested.total).toBe(11); expect(suggested.results).toHaveLength(3); expect(suggested.summary).toEqual(all.summary);
  const next = await browse({ offset: 60 }); expect(next.results).toHaveLength(13);
  expect(new Set([...all.results, ...next.results].map(r => r.sha256)).size).toBe(73);
  expect(all.control).toMatchObject({ paused: true, revision: 1, inFlight: [] });
  expect(await Runtime.findById('runtime').lean()).toEqual(before);
  expect(JSON.stringify(all)).not.toContain('never-return'); expect(all.results[0]).not.toHaveProperty('analysis');
});
test('suggestions exclude documents, cover art, privacy flags, poor quality and explicit dismissals without changing analysis', async () => {
  const rows=Array.from({length:8},(_,i)=>fixture(80+i));
  rows[0].analysis.card.proposal.description='Une pochette d’album avec un portrait.';
  rows[1].analysis.card.proposal.description='Une feuille de papier blanc froissée sur la table.';
  rows[2].analysis.card.proposal.description='Une capture d’écran nette.';
  rows[3].analysis.card.proposal.privacyReview=true;
  rows[4].analysis.card.proposal.quality='faible';
  rows[5].frame={revision:2,selected:false};
  rows[6].analysis.card.proposal.description='Un enfant dans un jardin, à côté des feuilles d’un arbre.';
  rows[7].frame={revision:1,selected:true};
  await Cards.create(rows);
  const before=await Cards.find({}).sort({_id:1}).lean();
  const suggestions=await browse({filter:'suggested'});
  expect(suggestions.results.map(x=>x.sha256)).toEqual([sha(86)]);
  expect(suggestions.summary).toMatchObject({total:8,suggested:1,frame:1,privacy:1});
  const all=await browse({});expect(all.total).toBe(8);
  expect(all.results[0].suggestion).toEqual({eligible:false,reason:'document-or-cover'});
  expect((await browse({filter:'frame'})).results[0].sha256).toBe(sha(87));
  expect(await Cards.find({}).sort({_id:1}).lean()).toEqual(before);
});
test('visual groups span pages and filters; every photo remains accessible and stale identities never group', async () => {
  await Cards.create([fixture(81),fixture(82),fixture(83),fixture(84)]);
  const cards=await Cards.find({}).sort({_id:1}).lean();
  await Similarity.create({_id:config.libraryId,version:1,operationId:uuid(),observedAt:new Date(),entries:[
    {sha256:sha(81),assetId:cards[0].assetId,groupId:sha(81)},
    {sha256:sha(82),assetId:cards[1].assetId,groupId:sha(81)},
    {sha256:sha(83),assetId:uuid(),groupId:sha(81)},
  ]});
  const grouped=await browse({filter:'suggested',limit:1});
  expect(grouped.total).toBe(3);expect(grouped.summary.suggested).toBe(4);
  expect(grouped.similarity).toMatchObject({mode:'grouped',images:4,indexed:2,total:4});
  expect(grouped.results[0].similarity).toEqual({groupId:sha(81),size:2});
  expect((await browse({filter:'suggested',offset:1,limit:1})).results[0].sha256).toBe(sha(83));
  expect((await browse({filter:'suggested',group:sha(81)})).results.map(x=>x.sha256)).toEqual([sha(81),sha(82)]);
  expect((await browse({filter:'suggested',similarity:'all'})).total).toBe(4);
  const searched=await browse({filter:'suggested',search:'Synthetic image 82'});
  expect(searched.results[0].sha256).toBe(sha(82));expect(searched.total).toBe(1);
  await Cards.updateOne({_id:sha(81)},{$set:{assetId:uuid()}});
  expect((await browse({filter:'suggested'})).total).toBe(4); // Stale anchor cannot alias a valid member's group.
  await Cards.updateOne({_id:sha(81)},{$set:{assetId:uuid()}});
  expect((await browse({filter:'suggested'})).total).toBe(4);
  await expect(browse({group:{$gt:''}})).rejects.toMatchObject({code:'INVALID_LIBRARY_QUERY'});
  await expect(browse({similarity:'delete'})).rejects.toMatchObject({code:'INVALID_LIBRARY_QUERY'});
});
test('only successful image proposals in the configured library are included; unavailable configuration exposes no cards', async () => {
  await Cards.create([fixture(1), fixture(2, { libraryId: uuid() }), fixture(3, { metadata: { type: 'VIDEO' } }),
    fixture(4, { analysis: { state: 'failed', card: { vision: 'not-attempted' } } }), fixture(5, { analysis: { state: 'running' } }),
    fixture(6, { analysis: { state: 'completed', card: {} } })]);
  expect((await browse({})).results.map(r => r.sha256)).toEqual([sha(1)]);
  config = null;
  expect(await browse({})).toMatchObject({ configured: false, results: [], total: 0, control: { paused: true }, summary: { total: 0 } });
});
test('literal text, human edits and metadata are searched globally before paging; quality and review filters combine', async () => {
  await Cards.create([fixture(1), fixture(71), fixture(72, { review: { approved: true, description: 'A human correction', tags: ['own label'] } })]);
  expect((await browse({ search: '[shore].*', limit: 1 })).results.map(r => r.sha256)).toEqual([sha(71)]);
  expect((await browse({ search: 'Fixture Bay' })).total).toBe(1);
  expect((await browse({ search: 'own label', filter: 'reviewed', quality: 'bonne' })).total).toBe(1);
  expect((await browse({ filter: 'privacy' })).total).toBe(1);
  expect((await browse({ quality: 'faible' })).total).toBe(0);
});
test('sorting is deterministic across tied dates and quality ordering handles unknown values', async () => {
  const values = [fixture(3), fixture(1), fixture(2)];
  values[0].analysis.card.proposal.quality = 'inconnue'; values[1].analysis.card.proposal.quality = 'moyenne';
  await Cards.create(values);
  expect((await browse({ order: 'quality' })).results.map(r => r.sha256)).toEqual([sha(2), sha(1), sha(3)]);
  expect((await browse({ order: 'recent', limit: 1 })).results[0].sha256).toBe(sha(1));
  expect((await browse({ order: 'recent', offset: 1, limit: 1 })).results[0].sha256).toBe(sha(2));
});
test('pending decisions carry the same reconciliation identity without full internal journals', async () => {
  const writeId = uuid(); await Cards.create(fixture(1, { pendingDecision: writeId }));
  await Decisions.create({ _id: writeId, sha256: sha(1), kind: 'frame', expectedRevision: 2, value: { selected: true }, inputHash: 'private' });
  const row = (await browse({})).results[0];
  expect(row.pendingIntent).toEqual({ writeId, kind: 'frame', expectedRevision: 2, value: { selected: true } });
  expect(JSON.stringify(row)).not.toContain('inputHash');
});
test.each([{ limit: 61 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { offset: 1000001 },
  { filter: '__proto__' }, { search: { $ne: '' } }, { search: 'x'.repeat(121) }, { order: 'random' }, { quality: [] }, { resume: true }])
('invalid queries refuse before the collection is read: %j', async input => {
  const aggregate = jest.spyOn(Cards, 'aggregate');
  await expect(browse(input)).rejects.toMatchObject({ code: 'INVALID_LIBRARY_QUERY' }); expect(aggregate).not.toHaveBeenCalled(); aggregate.mockRestore();
});
test('owner POST exposes global browsing, keeps GET configuration-only, and preserves family/demo boundaries', async () => {
  const app = express(), client = { json: jest.fn(), image: jest.fn() }, bridge = { call: jest.fn() };
  const service = createPhotoProcessingService({ config: () => config, client, bridge });
  registerPhotoProcessing({ app, express, service }); await Cards.create(fixture(1));
  const get = await request(app).get('/api/phone-media/processing').expect(200);
  expect(get.body.data).not.toHaveProperty('results'); expect(get.body.data).not.toHaveProperty('control');
  const response = await request(app).post('/api/phone-media/processing').send({ op: 'library', filter: 'suggested' }).expect(200);
  expect(response.body.data.control.paused).toBe(true);
  await request(app).post('/api/phone-media/processing').send({ op: 'library', start: true }).expect(400);
  expect(client.json).not.toHaveBeenCalled(); expect(client.image).not.toHaveBeenCalled(); expect(bridge.call).not.toHaveBeenCalled();
  for (const route of ['/diskx/photos', '/api/phone-media/processing', '/assets/diskx/photo-library.js', '/assets/diskx/photo-library-detail.js']) {
    expect(allowedForFamilyDevice({ path: route, method: 'GET' })).toBe(false);
    if (!route.startsWith('/assets/')) expect(demoSurfaceDisabled(route, 'demo')).toBe(true);
  }
});

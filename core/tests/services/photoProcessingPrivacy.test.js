'use strict';
const { createPhotoService } = require('../../src/services/photos/photoService');
const { parseProposal } = require('../../src/services/photos/photoAnalysis');
const { queuesIdle } = require('../../src/services/photos/photoProcessingWork');
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', LIB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('managed phone imports are excluded from family search, details and thumbnails', async () => {
  const client = { settings: () => ({ enabled: true }), image: jest.fn(),
    json: jest.fn(async p => p.startsWith('/assets/') ? { id: ID, libraryId: LIB, visibility: 'timeline' } : { assets: { items: [] } }) };
  const service = createPhotoService({ client, processingConfig: () => ({ libraryId: LIB }) });
  await service.smartSearch({ query: 'synthetic', audience: 'family' });
  expect(client.json.mock.calls[0][1].body.filter.libraryId).toEqual({ ne: LIB });
  await service.metadataSearch({ audience: 'family' });
  expect(client.json.mock.calls.at(-1)[1].body.filter.libraryId).toEqual({ ne: LIB });
  await expect(service.asset(ID, { audience: 'family' })).rejects.toMatchObject({ code: 'PHOTOS_NOT_FOUND' });
  await expect(service.thumbnail(ID, 'thumbnail', { audience: 'family' })).rejects.toMatchObject({ code: 'PHOTOS_NOT_FOUND' });
  expect(client.image).not.toHaveBeenCalled();
});
test('unavailable configuration fails closed for family queries', async () => {
  const client = { json: jest.fn() };
  const service = createPhotoService({ client, processingConfig: () => { throw Error('configuration unavailable'); } });
  await expect(service.metadataSearch({ audience: 'family' })).rejects.toThrow('configuration unavailable');
  expect(client.json).not.toHaveBeenCalled();
});
test('unbounded or malformed model proposals never become review cards', () => {
  const valid = { description: 'A synthetic scene', tags: ['nature'], quality: 'bonne', frameSuitability: 'à revoir', reasons: [], privacyReview: false };
  expect(parseProposal(JSON.stringify(valid))).toEqual(valid);
  for (const value of [{ ...valid, description: 'x'.repeat(1201) }, { ...valid, tags: Array(11).fill('a') },
    { ...valid, quality: 'certain' }, { ...valid, privacyReview: 'false' }, [], 'bad'])
    expect(() => parseProposal(JSON.stringify(value))).toThrow();
  expect(() => parseProposal('not-json')).toThrow();
});
test('missing or paused upstream jobs cannot release a heavy-work window', () => {
  expect(queuesIdle({})).toBe(false);
  const names = ['library', 'metadataExtraction', 'thumbnailGeneration', 'smartSearch', 'faceDetection', 'facialRecognition',
    'ocr', 'duplicateDetection', 'videoConversion', 'sidecar', 'workflow', 'backgroundTask', 'search'];
  const queues = Object.fromEntries(names.map(n => [n, { queueStatus: { isActive: false }, jobCounts: { active: 0, waiting: 0, delayed: 0, paused: 0 } }]));
  expect(queuesIdle(queues)).toBe(true);
  queues.library.jobCounts.paused = 1; expect(queuesIdle(queues)).toBe(false);
});

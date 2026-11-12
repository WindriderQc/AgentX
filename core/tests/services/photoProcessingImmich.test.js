'use strict';
const { createPhotoProcessingImmich, metadata } = require('../../src/services/photos/photoProcessingImmich');
const { provision } = require('../../src/services/photos/photoProcessingSetup');
const Setup = require('../../models/PhotoProcessingSetup');
const crypto = require('node:crypto'), uuid = () => crypto.randomUUID();
beforeEach(async () => { await Setup.deleteMany({}); });
test('asset linkage requires the exact managed library, path, checksum and original byte count', async () => {
  const fixed = { libraryId: uuid(), originalPathPrefix: '/gallery' }, assetId = uuid();
  const projection = { relativePath: 'run/photo.jpg', size: 123, immichChecksum: 'synthetic-sha1' };
  let value = { id: assetId, libraryId: fixed.libraryId, originalPath: '/gallery/run/photo.jpg', checksum: projection.immichChecksum,
    hasMetadata: true, exifInfo: { fileSizeInByte: 123 } };
  const client = { json: jest.fn(async p => p === '/search/metadata' ? { assets: { items: [{ id: assetId }] } } : value) };
  const upstream = createPhotoProcessingImmich({ client, config: () => fixed });
  expect((await upstream.asset(projection)).id).toBe(assetId);
  const original = structuredClone(value);
  for (const changed of [{ libraryId: uuid() }, { originalPath: '/gallery-other/run/photo.jpg' }, { checksum: 'different' },
    { exifInfo: { fileSizeInByte: 124 } }, { isOffline: true }]) {
    value = { ...original, ...changed };
    await expect(upstream.asset(projection)).rejects.toMatchObject({ code: 'PHOTO_ASSET_MISMATCH' });
  }
});
test('metadata keeps extracted values bounded and explicitly marks truncated fields', () => {
  const result = metadata({ exifInfo: { description: 'é'.repeat(10000), city: 'x'.repeat(1000) }, people: Array.from({ length: 30 }, () => ({ id: uuid(), name: '人'.repeat(1000) })),
    tags: Array(100).fill({ value: 'é'.repeat(1000) }) }, '文'.repeat(10000));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(40000);
  expect(result.truncatedFields).toEqual(expect.arrayContaining(['exif.description', 'exif.city', 'ocr']));
  expect(result.peopleTruncated).toBe(true); expect(result.tagsTruncated).toBe(true);
});
test('provisioning reconciles lost library and album responses without another creation or scan', async () => {
  const ownerId = uuid(), request = { operationId: uuid(), libraryName: 'Synthetic imports', albumName: 'Synthetic frame', originalPathPrefix: '/gallery' };
  let library, album;
  const client = { json: jest.fn(async (p, options) => {
    if (p === '/users/me') return { id: ownerId };
    if (p === '/libraries' && !options) return library ? [library] : [];
    if (p === '/albums' && !options) return album ? [album] : [];
    if (p === '/libraries') { library = { id: uuid(), ...options.body }; throw Error('library reply lost'); }
    if (p === '/albums') { album = { id: uuid(), shared: false, hasSharedLink: false, ...options.body }; throw Error('album reply lost'); }
    throw Error('Unexpected upstream effect');
  }) };
  await expect(provision(request, { client })).rejects.toThrow('library reply lost');
  await expect(provision(request, { client })).rejects.toThrow('album reply lost');
  expect(await provision(request, { client })).toMatchObject({ libraryId: library.id, frameAlbumId: album.id, scanStarted: false });
  expect(client.json.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2);
  await expect(provision({ ...request, originalPathPrefix: '/other' }, { client })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
});
test('an unobserved provisioning dispatch remains fenced even when the upstream inventory is empty', async () => {
  const request = { operationId: uuid(), libraryName: 'Synthetic imports', albumName: 'Synthetic frame', originalPathPrefix: '/gallery' };
  const ownerId = uuid(), client = { json: jest.fn(async (p, options) => {
    if (p === '/users/me') return { id: ownerId };
    if (options?.method === 'POST') throw Error('upstream result unknown');
    return [];
  }) };
  await expect(provision(request, { client })).rejects.toThrow('upstream result unknown');
  await expect(provision(request, { client })).rejects.toMatchObject({ code: 'PHOTO_SETUP_UNKNOWN' });
  expect(client.json.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});


test('external path checksums link only the verified library/path and await metadata extraction', async () => {
  const fixed = { libraryId: uuid(), originalPathPrefix: '/gallery' }, assetId = uuid();
  const projection = { relativePath: 'run/photo.jpg', size: 123, immichChecksum: 'content-sha1' };
  // Immich contract: SHA-1 of the exact path: prefix + original path.
  let value = { id: assetId, libraryId: fixed.libraryId, originalPath: '/gallery/run/photo.jpg',
    checksum: 'yPm62MY7AX2A65rYlkD+LXzJoKM=', hasMetadata: false };
  const client = { json: jest.fn(async p => p === '/search/metadata' ? { assets: { items: [{ id: assetId }] } } : value) };
  const upstream = createPhotoProcessingImmich({ client, config: () => fixed });
  expect(await upstream.asset(projection)).toBeNull();
  value = { ...value, hasMetadata: true };
  expect(await upstream.asset(projection)).toBeNull();
  value = { ...value, exifInfo: { fileSizeInByte: null } };
  expect(await upstream.asset(projection)).toBeNull();
  value = { ...value, hasMetadata: true, exifInfo: { fileSizeInByte: 123 } };
  expect((await upstream.asset(projection)).id).toBe(assetId);
  const original = structuredClone(value);
  for (const patch of [{ checksum: undefined }, { checksum: 'another-path-checksum' }, { originalPath: '/gallery/run/other.jpg' },
    { libraryId: uuid() }, { exifInfo: { fileSizeInByte: 124 } }, { isTrashed: true }]) {
    value = { ...original, ...patch };
    await expect(upstream.asset(projection)).rejects.toMatchObject({ code: 'PHOTO_ASSET_MISMATCH' });
  }
  value = { ...original, hasMetadata: false, libraryId: uuid() };
  await expect(upstream.asset(projection)).rejects.toMatchObject({ code: 'PHOTO_ASSET_MISMATCH' });
});

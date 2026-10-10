'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

jest.mock('../../models/ImageOperation', () => ({
  findById: jest.fn(), create: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn()
}));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn() }));
const Model = require('../../models/ImageOperation');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { reserve } = require('../../src/services/images/gpuReservation');
const { decode } = require('../../src/services/images/codec');
const { request, compose, createService, SCHEMA, MAX_PIXELS } = require('../../src/services/images/protectedComposition');
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function image(width = 4, height = 3, offset = 0) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = (index + offset) % 256; data[index + 1] = (41 + offset) % 256;
    data[index + 2] = (173 + offset) % 256;
    data[index + 3] = [0, 63, 128, 255][(index / 4) % 4];
  }
  return PNG.sync.write({ width, height, data }, { colorType: 6 });
}
function fixture() {
  const parentId = randomUUID(), childId = randomUUID(), parentBytes = image(), childBytes = image(4, 3, 53);
  const parent = { _id: parentId, state: 'completed', runtimeRestored: true,
    artifact: { sha256: sha(parentBytes), width: 4, height: 3, mimeType: 'image/png', path: 'generated/fixture-parent.png' } };
  const child = { _id: childId, state: 'completed', runtimeRestored: true,
    artifact: { sha256: sha(childBytes), width: 4, height: 3, mimeType: 'image/png', path: 'generated/fixture-child.png' },
    lineage: { version: 1, parent: { operationId: parentId, sha256: sha(parentBytes), width: 4, height: 3 } } };
  const records = new Map([[parentId, parent], [childId, child]]);
  const operations = { findById: jest.fn(id => ({ lean: async () => clone(records.get(id) || null) })),
    create: jest.fn(), updateOne: jest.fn(), deleteOne: jest.fn() };
  const files = new Map([[parent.artifact.sha256, parentBytes], [child.artifact.sha256, childBytes]]);
  const storage = { read: jest.fn(async receipt => ({ bytes: files.get(receipt.sha256), mimeType: receipt.mimeType })),
    store: jest.fn(), delete: jest.fn() };
  const archive = jest.fn(() => storage), service = createService({ operations, archive });
  const body = { parentSha256: parent.artifact.sha256, resultSha256: child.artifact.sha256, regions: [{ x: 1, y: 1, width: 2, height: 1 }] };
  return { parent, child, parentBytes, childBytes, records, operations, storage, archive, service, body, childId };
}

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => {
  expect(Model.create).not.toHaveBeenCalled(); expect(Model.updateOne).not.toHaveBeenCalled();
  expect(Model.updateMany).not.toHaveBeenCalled(); expect(Model.deleteMany).not.toHaveBeenCalled();
  expect(createComfyClient).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
});

test('PNG composition preserves every RGBA byte outside an overlapping rectangle union after reencoding', () => {
  const parentBytes = image(), resultBytes = image(4, 3, 71);
  const parent = decode(parentBytes), result = decode(resultBytes);
  const parentBefore = Buffer.from(parentBytes), resultBefore = Buffer.from(resultBytes);
  const regions = [{ x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 3, height: 2 }];
  const composed = compose(parentBytes, resultBytes, regions), output = decode(composed.png);
  const outside = createHash('sha256'); let selectedPixels = 0;
  for (let y = 0; y < parent.height; y += 1) for (let x = 0; x < parent.width; x += 1) {
    const start = (y * parent.width + x) * 4;
    const selected = regions.some(region => x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height);
    expect(output.data.subarray(start, start + 4)).toEqual((selected ? result : parent).data.subarray(start, start + 4));
    if (selected) selectedPixels += 1; else outside.update(parent.data.subarray(start, start + 4));
  }
  expect(composed.proof).toMatchObject({ verified: true, selectedPixels, protectedPixels: 12 - selectedPixels,
    outsideRgbaSha256: outside.digest('hex'), outputSha256: sha(composed.png) });
  expect(parentBytes).toEqual(parentBefore); expect(resultBytes).toEqual(resultBefore);
  expect(composed.regions).toEqual(regions); expect(composed.regions).not.toBe(regions);
});

test('one border pixel is replaced verbatim including alpha zero and RGB beneath transparency', () => {
  const parentBytes = image(), result = decode(image(4, 3, 9));
  const index = (3 + 2 * 4) * 4; result.data.set([222, 17, 99, 0], index);
  const resultBytes = PNG.sync.write(result);
  const composed = compose(parentBytes, resultBytes, [{ x: 3, y: 2, width: 1, height: 1 }]);
  const output = decode(composed.png);
  expect(output.data.subarray(index, index + 4)).toEqual(Buffer.from([222, 17, 99, 0]));
  expect(composed.proof).toMatchObject({ selectedPixels: 1, protectedPixels: 11 });
});

test('a full image selection reports an empty protected union without inventing protected pixels', () => {
  const resultBytes = image(4, 3, 32);
  const composed = compose(image(), resultBytes, [{ x: 0, y: 0, width: 4, height: 3 }]);
  expect(decode(composed.png).data).toEqual(decode(resultBytes).data);
  expect(composed.proof).toMatchObject({ selectedPixels: 12, protectedPixels: 0, outsideRgbaSha256: sha(Buffer.alloc(0)) });
});

test('JPEG sources preserve their decoded RGBA outside the selected area in a lossless PNG', () => {
  const raw = decode(image()); raw.data.forEach((_value, index) => { if (index % 4 === 3) raw.data[index] = 255; });
  const parentBytes = jpeg.encode(raw, 75).data, resultBytes = image(4, 3, 42);
  const parent = decode(parentBytes), result = decode(resultBytes);
  const composed = compose(parentBytes, resultBytes, [{ x: 1, y: 1, width: 1, height: 1 }]);
  const expected = Buffer.from(parent.data); result.data.copy(expected, 20, 20, 24);
  expect(decode(composed.png).data).toEqual(expected);
  expect(composed.proof.protectedPixels).toBe(11);
});

test.each([
  ['mismatched dimensions', image(5, 3), [{ x: 0, y: 0, width: 1, height: 1 }], 409],
  ['outside right edge', image(), [{ x: 4, y: 0, width: 1, height: 1 }], 400],
  ['outside bottom edge', image(), [{ x: 0, y: 2, width: 1, height: 2 }], 400],
  ['negative position', image(), [{ x: -1, y: 0, width: 1, height: 1 }], 400],
  ['empty region', image(), [{ x: 0, y: 0, width: 0, height: 1 }], 400],
  ['fractional coordinates', image(), [{ x: 0.5, y: 0, width: 1, height: 1 }], 400]
])('refuses %s without resizing or clipping', (_name, result, regions, statusCode) => {
  try { compose(image(), result, regions); throw new Error('Expected refusal'); }
  catch (error) { expect(error.statusCode).toBe(statusCode); }
});

test('refuses oversized PNG headers before pixel allocation', () => {
  const parent = image(); parent.writeUInt32BE(MAX_PIXELS + 1, 16);
  expect(() => compose(parent, image(), [{ x: 0, y: 0, width: 1, height: 1 }])).toThrow('limites');
});

test.each(['parent', 'result'])('refuses an interlaced PNG %s header before invoking any image decoder', target => {
  const ordinary = image(), interlaced = Buffer.from(ordinary.subarray(0, 33));
  interlaced[28] = 1;
  const pngRead = jest.spyOn(PNG.sync, 'read'), jpegDecode = jest.spyOn(jpeg, 'decode');
  try {
    expect(() => compose(target === 'parent' ? interlaced : ordinary, target === 'result' ? interlaced : ordinary,
      [{ x: 0, y: 0, width: 1, height: 1 }])).toThrow('PNG entrelacés');
    expect(pngRead).not.toHaveBeenCalled(); expect(jpegDecode).not.toHaveBeenCalled();
  } finally { pngRead.mockRestore(); jpegDecode.mockRestore(); }
});

test.each([
  value => { value.parentSha256 = [value.parentSha256]; }, value => { value.resultSha256 = [value.resultSha256]; },
  value => { value.parentSha256 = 17; }, value => { value.resultSha256 = {}; },
  value => { value.schema = 'unknown'; }, value => { value.path = '/untrusted.png'; },
  value => { value.regions = []; }, value => { value.regions = Array.from({ length: 21 }, () => value.regions[0]); },
  value => { value.regions[0].extra = true; }, value => { value.regions[0].x = Infinity; },
  value => { value.regions[0].width = Number.MAX_SAFE_INTEGER + 1; }
])('refuses malformed scalar hashes, regions and unsupported request fields', mutate => {
  const f = fixture(), body = clone(f.body); mutate(body); expect(() => request(body)).toThrow();
});

test('canonical service returns provenance and proof without writes, worker calls or private paths', async () => {
  const f = fixture(), before = JSON.stringify([...f.records]), output = await f.service.build(f.childId, f.body);
  expect(output.receipt).toMatchObject({ schema: SCHEMA, parent: { operationId: f.parent._id, sha256: sha(f.parentBytes) },
    result: { operationId: f.childId, sha256: sha(f.childBytes) }, width: 4, height: 3, regions: f.body.regions });
  expect(output.receipt.proof.outputSha256).toBe(sha(Buffer.from(output.png, 'base64')));
  expect(JSON.stringify(output.receipt)).not.toMatch(/path|worker|admission/);
  expect(f.operations.findById).toHaveBeenCalledTimes(4); expect(f.storage.read.mock.calls.map(([receipt]) => receipt.path))
    .toEqual(['generated/fixture-parent.png', 'generated/fixture-child.png']);
  expect(f.operations.create).not.toHaveBeenCalled(); expect(f.operations.updateOne).not.toHaveBeenCalled();
  expect(f.storage.store).not.toHaveBeenCalled(); expect(f.storage.delete).not.toHaveBeenCalled();
  expect(JSON.stringify([...f.records])).toBe(before);
});

test.each([
  f => { f.child.state = 'generating'; }, f => { f.child.runtimeRestored = false; },
  f => { delete f.child.lineage; }, f => { f.parent.runtimeRestored = false; },
  f => { f.parent.state = 'unknown'; }, f => { f.child.lineage.parent.sha256 = 'a'.repeat(64); },
  f => { f.child.lineage.parent.operationId = f.childId; }, f => { f.body.resultSha256 = 'b'.repeat(64); },
  f => { f.body.parentSha256 = 'c'.repeat(64); }, f => { f.child.lineage.parent.width = 5; }
])('refuses unready or mismatched lineage before reading image archives', async mutate => {
  const f = fixture(); mutate(f); await expect(f.service.build(f.childId, f.body)).rejects.toMatchObject({ statusCode: 409 });
  expect(f.storage.read).not.toHaveBeenCalled();
});

test('refuses archive bytes whose digest differs from the canonical receipt', async () => {
  const f = fixture(); f.storage.read.mockResolvedValueOnce({ bytes: image(4, 3, 123) });
  await expect(f.service.build(f.childId, f.body)).rejects.toMatchObject({ statusCode: 503 });
});

test('refuses receipt dimensions differing from actual decoded images', async () => {
  const f = fixture(); f.child.artifact.width = 5;
  await expect(f.service.build(f.childId, f.body)).rejects.toMatchObject({ statusCode: 503 });
});

test.each(['parent', 'child'])('rereads source records and refuses a changed %s while composing', async target => {
  const f = fixture(), original = f.storage.read.getMockImplementation(); let reads = 0;
  f.storage.read.mockImplementation(async receipt => {
    const result = await original(receipt); if (++reads === 2) f[target].state = 'cancelled'; return result;
  });
  await expect(f.service.build(f.childId, f.body)).rejects.toMatchObject({ statusCode: 409 });
});

test('serializes composition work and releases the mutex after an archive failure', async () => {
  const f = fixture(); let reject;
  f.storage.read.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const pending = f.service.build(f.childId, f.body);
  while (!reject) await new Promise(resolve => setImmediate(resolve));
  await expect(f.service.build(f.childId, f.body)).rejects.toMatchObject({ statusCode: 409 });
  reject(new Error('Fixture read failure')); await expect(pending).rejects.toThrow('Fixture read failure');
  expect((await f.service.build(f.childId, f.body)).receipt.proof.verified).toBe(true);
});

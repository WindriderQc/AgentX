'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createPhotoImportService } = require('../../../core/src/services/photos/photoImportService');
const { createPhotoProjection } = require('../../../core/src/services/photos/photoProjection');
const uuid = () => crypto.randomUUID(), sha = x => crypto.createHash('sha256').update(x).digest('hex');
async function fixture(t, name = 'image.jpg', bytes = Buffer.from('synthetic media'), header) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-project-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = await createPhotoImportService({ root });
  const runId = uuid(), requestId = uuid(), source = { requestId, key: 'one', name, relativePath: 'Storage/DCIM/'+name, size: bytes.length, modified: null, ...(header ? { header } : {}) };
  await service.begin({ runId, deviceKey: sha('fake-phone'), coverage: { enumerationComplete: true }, sources: [source] });
  const receipt = await service.receive({ runId, requestId, sha256: sha(bytes), size: bytes.length }, Readable.from([bytes]));
  const projection = await createPhotoProjection({ root });
  return { root, service, runId, requestId, bytes, receipt, projection, input: { operationId: uuid(), runId, items: [requestId] } };
}
test('a verified original is represented by a same-inode link, with stable replay and no extra original bytes', async t => {
  const f = await fixture(t);
  const result = await f.projection.project(f.input), row = result.results[0];
  const target = path.join(f.projection.directory, row.relativePath);
  const [original, link] = await Promise.all([fs.stat(f.receipt.path), fs.stat(target)]);
  assert.equal(link.ino, original.ino); assert.equal(link.dev, original.dev); assert.equal(original.nlink, 2);
  assert.deepEqual(await fs.readFile(target), f.bytes);
  assert.equal((await f.projection.project(f.input)).results[0].relativePath, row.relativePath);
  assert.equal((await fs.stat(f.receipt.path)).nlink, 2);
  await assert.rejects(f.projection.project({ ...f.input, items: [uuid()] }), { code: 'REQUEST_CONFLICT' });
});
test('concurrent content projection claims create one reference across different transport operations', async t => {
  const f = await fixture(t);
  const rows = await Promise.all(Array.from({ length: 6 }, () => f.projection.project({ ...f.input, operationId: uuid() })));
  assert.equal(new Set(rows.map(r => r.results[0].relativePath)).size, 1);
  assert.equal((await fs.stat(f.receipt.path)).nlink, 2);
});
test('changed media and escaped originals are refused before publication', async t => {
  const f = await fixture(t); await fs.writeFile(f.receipt.path, 'changed media');
  await assert.rejects(f.projection.project(f.input), { code: 'COPY_VERIFICATION_FAILED' });
  await fs.rm(f.receipt.path); const outside = path.join(f.root, 'outside.jpg'); await fs.writeFile(outside, f.bytes);
  await fs.symlink(outside, f.receipt.path);
  await assert.rejects(f.projection.project(f.input), { code: 'UNSAFE_PATH' });
});
test('companions stay backed up without becoming gallery assets', async t => {
  const f = await fixture(t, 'image.aae', Buffer.from('preserved adjustment bytes'));
  const result = await f.projection.project(f.input);
  assert.equal(result.results[0].skipped, 'companion'); assert.deepEqual(await fs.readFile(f.receipt.path), f.bytes);
});
test('card export binds content and analysis identity and preserves an immutable portable record', async t => {
  const f = await fixture(t); await f.projection.project(f.input);
  const analysisId = uuid(), card = { sourceSha256: f.receipt.sha256, analysisId, description: 'Synthetic proposal', reviewed: false };
  const input = { sha256: f.receipt.sha256, analysisId, card };
  assert.equal((await f.projection.exportCard(input)).exported, true);
  assert.deepEqual(await f.projection.exportCard(input), await f.projection.exportCard(input));
  await assert.rejects(f.projection.exportCard({ ...input, card: { ...card, description: 'different' } }), { code: 'REQUEST_CONFLICT' });
  await assert.rejects(f.projection.exportCard({ ...input, card: { ...card, sourceSha256: '0'.repeat(64) } }), { code: 'INVALID_CARD' });
});


for (const legacy of [false, true]) test('signature-only images receive a gallery extension; immutable legacy intent: '+legacy, async t => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex');
  const f = await fixture(t, 'cache.file', bytes, bytes.toString('base64'));
  const slot = path.join(f.root, '.agentx-import/gallery-references', f.receipt.sha256);
  let intent;
  if (legacy) {
    await fs.mkdir(slot, { recursive: true });
    intent = { schema: 'agentx.photo-projection/v1', sha256: f.receipt.sha256, size: bytes.length,
      relativePath: f.runId+'/'+sha('Storage/DCIM')+'/cache.file', runId: f.runId, requestId: f.requestId };
    await fs.writeFile(path.join(slot, 'intent.json'), JSON.stringify(intent));
  }
  const row = (await f.projection.project(f.input)).results[0];
  assert.equal(path.basename(row.relativePath), f.receipt.sha256+'.png');
  assert.deepEqual(await fs.readFile(path.join(f.projection.directory, row.relativePath)), bytes);
  if (legacy) assert.deepEqual(JSON.parse(await fs.readFile(path.join(slot, 'intent.json'))), intent);
  assert.equal((await f.projection.project(f.input)).results[0].relativePath, row.relativePath);
});

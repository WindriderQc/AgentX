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

test('gallery tags use separate versioned XMP bytes and leave original media and backed-up companions intact',async t=>{
  const f=await fixture(t);const p=(await f.projection.project(f.input)).results[0];
  const original=await fs.stat(f.receipt.path), target=path.join(f.projection.directory,p.relativePath+'.xmp');
  const input={sha256:p.sha256,writeId:uuid(),revision:0,tags:['Famille & amis','AgentX/Relecture/à relire','photo <été> "2026" 🐈']};
  const result=await f.projection.syncTags(input);assert.equal(result.persisted,true);
  const xml=await fs.readFile(target,'utf8');assert.match(xml,/Famille &amp; amis/);assert.match(xml,/&lt;été&gt; &quot;2026&quot; 🐈/);
  const sidecar=await fs.stat(target);assert.notEqual(sidecar.ino,original.ino);assert.equal(sidecar.nlink,1);
  const after=await fs.stat(f.receipt.path);assert.equal(after.ino,original.ino);assert.equal(after.mtimeMs,original.mtimeMs);
  assert.deepEqual(await fs.readFile(f.receipt.path),f.bytes);
  assert.equal((await f.projection.syncTags(input)).sidecarSha256,result.sidecarSha256);
  await assert.rejects(f.projection.syncTags({...input,tags:['changed']}),{code:'REQUEST_CONFLICT'});
  const reviewInput={...input,writeId:uuid(),revision:1,tags:['AgentX/Téléphone/Relu','Famille & amis']};
  const reviewed=await f.projection.syncTags(reviewInput);
  assert.equal(reviewed.revision,1);assert.equal((await f.projection.syncTags(input)).superseded,true);
  assert.doesNotMatch(await fs.readFile(target,'utf8'),/à relire/);
  await assert.rejects(f.projection.syncTags({...reviewInput,writeId:uuid()}),{code:'PHOTO_TAGS_CHANGED'});
  // A lost response/publication after the XMP but before its pointer retains
  // the immutable intent and is reconciled through the same identity.
  await fs.rm(path.join(f.root,'.agentx-import/gallery-sidecars',p.sha256,'current.json'));
  assert.equal((await f.projection.syncTags(reviewInput)).sidecarSha256,reviewed.sidecarSha256);
  await fs.writeFile(target,'human XMP edit');
  await assert.rejects(f.projection.syncTags({...input,writeId:uuid(),revision:2}),{code:'PHOTO_SIDECAR_CONFLICT'});
  assert.equal(await fs.readFile(target,'utf8'),'human XMP edit');
});
test('unknown sidecars, symlinks, hardlinks, invalid XML text and concurrent unknown writers refuse without changing originals',async t=>{
  const f=await fixture(t);const p=(await f.projection.project(f.input)).results[0],target=path.join(f.projection.directory,p.relativePath+'.xmp');
  const input={sha256:p.sha256,writeId:uuid(),revision:0,tags:['review']};
  await fs.writeFile(target,'existing companion');
  await assert.rejects(f.projection.syncTags(input),{code:'PHOTO_SIDECAR_CONFLICT'});await fs.rm(target);
  await fs.symlink(f.receipt.path,target);await assert.rejects(f.projection.syncTags(input),{code:'PHOTO_SIDECAR_CONFLICT'});await fs.rm(target);
  await fs.link(f.receipt.path,target);await assert.rejects(f.projection.syncTags(input),{code:'PHOTO_SIDECAR_CONFLICT'});await fs.rm(target);
  await assert.rejects(f.projection.syncTags({...input,tags:['bad\u0000text']}),{code:'INVALID_PHOTO_TAGS'});
  await assert.rejects(f.projection.syncTags({...input,tags:Array.from({length:48},(_,i)=>'&'.repeat(900)+i)}),{code:'INVALID_PHOTO_TAGS'});
  const lock=path.join(f.root,'.agentx-import/gallery-sidecars',p.sha256,'lock');await fs.mkdir(lock);
  await assert.rejects(f.projection.syncTags(input),{code:'PHOTO_TAGS_HELD'});
  assert.deepEqual(await fs.readFile(f.receipt.path),f.bytes);
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

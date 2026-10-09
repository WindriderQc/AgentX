'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const { createImageArchive, MAX_BYTES } = require('../../src/services/imageArchive');
const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
let root, outside, archive, receipt;
const read = r => { expect(typeof archive.read).toBe('function'); return archive.read(r); };
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-archive-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-archive-outside-'));
  archive = createImageArchive({ dir: root });
  receipt = await archive.store({ bytes, origin: 'uploaded', name: 'synthetic.png' });
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
test('the actual archive reader returns precisely the receipt bytes and MIME', async () => {
  expect(await read(receipt)).toMatchObject({ bytes, mimeType: 'image/png' });
});
test.each(['../escape.png', '/tmp/absolute.png', 'uploaded/../escape.png', 'uploaded\\escape.png'])('noncanonical receipt path %s is refused', async value => {
  await expect(read({ ...receipt, path: value })).rejects.toBeDefined();
});
test('a static symlink file is refused even when its target bytes satisfy the receipt', async () => {
  const target = path.join(outside, 'target.png'); fs.writeFileSync(target, bytes);
  const file = path.join(root, receipt.path); fs.unlinkSync(file); fs.symlinkSync(target, file);
  await expect(read(receipt)).rejects.toBeDefined(); expect(fs.readFileSync(target)).toEqual(bytes);
});
test('a static symlink directory is refused even when its target bytes satisfy the receipt', async () => {
  const components = receipt.path.split('/'); const directory = path.join(root, components[0]);
  const target = path.join(outside, 'bucket'); fs.renameSync(directory, target); fs.symlinkSync(target, directory);
  await expect(read(receipt)).rejects.toBeDefined();
  expect(fs.readFileSync(path.join(outside, 'bucket', ...components.slice(1)))).toEqual(bytes);
});
test('a missing archive file refuses and is not reconstructed', async () => {
  const file = path.join(root, receipt.path); fs.unlinkSync(file);
  await expect(read(receipt)).rejects.toBeDefined(); expect(fs.existsSync(file)).toBe(false);
});
test('a directory cannot masquerade as a regular archived image', async () => {
  const file = path.join(root, receipt.path); fs.unlinkSync(file); fs.mkdirSync(file);
  await expect(read(receipt)).rejects.toBeDefined();
});
test.each([{ size: bytes.length + 1 }, { sha256: '0'.repeat(64) }, { mimeType: 'image/jpeg' },
  { size: 0 }, { size: MAX_BYTES + 1 }])('receipt integrity mismatch %j is refused', async extra => {
  await expect(read({ ...receipt, ...extra })).rejects.toBeDefined();
});
test('same-length corrupted archive bytes refuse without repair on read', async () => {
  const file = path.join(root, receipt.path), corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1] ^= 1;
  fs.writeFileSync(file, corrupted); await expect(read(receipt)).rejects.toBeDefined();
  expect(fs.readFileSync(file)).toEqual(corrupted);
});

test('a path replaced after open returns original handle bytes or refuses closed, never replacement bytes', async () => {
  const file = path.join(root, receipt.path), open = fs.promises.open.bind(fs.promises); let replaced = false;
  jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!replaced && String(args[0]) === file) {
      replaced = true; fs.renameSync(file, `${file}.original`); fs.writeFileSync(file, Buffer.alloc(bytes.length));
    }
    return handle;
  });
  let result, error;
  try { result = await read(receipt); } catch (e) { error = e; }
  if (error) expect(error).toMatchObject({ statusCode: 503 });
  else expect(result.bytes).toEqual(bytes);
  expect(replaced).toBe(true);
  expect(fs.readFileSync(file)).toEqual(Buffer.alloc(bytes.length));
  expect(fs.readFileSync(`${file}.original`)).toEqual(bytes);
});

test('archive writer refuses a symlink child directory before placing a new unique blob outside', async () => {
  const bucket = path.join(outside, 'bucket'); fs.mkdirSync(bucket);
  fs.rmSync(path.join(root, 'uploaded'), { recursive: true }); fs.symlinkSync(bucket, path.join(root, 'uploaded'));
  const fresh = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16) });
  let error; try { await archive.store({ bytes: fresh, origin: 'uploaded' }); } catch (e) { error = e; }
  expect(fs.readdirSync(bucket)).toEqual([]);
  expect(error).toMatchObject({ statusCode: 503 });
});
test('archive writer refuses an existing blob symlink with its outside target intact', async () => {
  const target = path.join(outside, 'blob.png'); fs.writeFileSync(target, bytes);
  const file = path.join(root, receipt.path); fs.unlinkSync(file); fs.symlinkSync(target, file);
  let error; try { await archive.store({ bytes, origin: 'uploaded' }); } catch (e) { error = e; }
  expect(fs.readFileSync(target)).toEqual(bytes); expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  expect(error).toMatchObject({ statusCode: 503 });
});
test('archive writer refuses a sidecar symlink before overwriting its outside target', async () => {
  const target = path.join(outside, 'sidecar.json'), sentinel = Buffer.from('SYNTHETIC_SIDECAR_SENTINEL');
  fs.writeFileSync(target, sentinel);
  const sidecar = path.join(root, receipt.path.replace(/\.[a-z]+$/, '.json'));
  fs.unlinkSync(sidecar); fs.symlinkSync(target, sidecar);
  let error; try { await archive.store({ bytes, origin: 'uploaded' }); } catch (e) { error = e; }
  expect(fs.readFileSync(target)).toEqual(sentinel); expect(fs.lstatSync(sidecar).isSymbolicLink()).toBe(true);
  expect(error).toMatchObject({ statusCode: 503 });
});
test('configured root alias permits exact store and read while child symlinks remain forbidden', async () => {
  const alias = path.join(outside, 'authorized-root'); fs.symlinkSync(root, alias);
  const aliased = createImageArchive({ dir: alias });
  const stored = await aliased.store({ bytes, origin: 'uploaded' });
  expect(fs.readFileSync(path.join(root, stored.path))).toEqual(bytes);
  expect(typeof aliased.read).toBe('function'); expect((await aliased.read(stored)).bytes).toEqual(bytes);
});

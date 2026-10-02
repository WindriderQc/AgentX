'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createImageArchive, sniff } = require('../../src/services/imageArchive');

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic jpeg body')]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=', 'base64');
const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12)]);

describe('image archive', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-archive-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('recognizes images by their bytes, not their declared type', () => {
    expect(sniff(jpeg)).toBe('image/jpeg');
    expect(sniff(png)).toBe('image/png');
    expect(sniff(heic)).toBe('image/heic');
    expect(sniff(Buffer.from('not an image'))).toBeNull();
  });

  test('is off without a directory', async () => {
    const archive = createImageArchive({ dir: '' });
    expect(archive.enabled).toBe(false);
    await expect(archive.store({ bytes: jpeg, origin: 'uploaded' })).resolves.toBeNull();
  });

  test('keeps the original once, content-addressed by origin and month, with a sidecar', async () => {
    const archive = createImageArchive({ dir, now: () => new Date('2026-10-02T12:00:00Z') });
    const first = await archive.store({ bytes: jpeg, name: 'IMG_0001.jpg', origin: 'uploaded', context: { attachmentId: 'a1' } });
    expect(first).toMatchObject({ mimeType: 'image/jpeg', size: jpeg.length, origin: 'uploaded', duplicate: false });
    expect(first.path).toBe(`uploaded/2026/10/${first.sha256}.jpg`);
    const file = path.join(dir, 'uploaded', '2026', '10', `${first.sha256}.jpg`);
    expect(fs.readFileSync(file).equals(jpeg)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(file.replace(/\.jpg$/, '.json'), 'utf8'));
    expect(sidecar).toMatchObject({ name: 'IMG_0001.jpg', context: { attachmentId: 'a1' } });
    const again = await archive.store({ bytes: jpeg, name: 'copy.jpg', origin: 'uploaded' });
    expect(again).toMatchObject({ sha256: first.sha256, duplicate: true });
    expect(fs.readdirSync(path.dirname(file))).toHaveLength(2);
    const generated = await archive.store({ bytes: png, origin: 'generated' });
    expect(generated.path).toMatch(/^generated\/2026\/10\/[a-f0-9]{64}\.png$/);
  });

  test('refuses an empty, unknown or non-image payload', async () => {
    const archive = createImageArchive({ dir });
    await expect(archive.store({ bytes: Buffer.alloc(0), origin: 'uploaded' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(archive.store({ bytes: Buffer.from('text'), origin: 'uploaded' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(archive.store({ bytes: jpeg, origin: 'elsewhere' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

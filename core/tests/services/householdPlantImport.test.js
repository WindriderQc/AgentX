'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const request = require('supertest');
const express = require('express');
const Plant = require('../../models/HouseholdPlant');
const Photo = require('../../models/HouseholdPlantPhoto');
const Imports = require('../../models/HouseholdPlantImport');
const { createPlantFolder, sha256 } = require('../../src/services/householdPlantFolder');
const { createPlantImport } = require('../../src/services/householdPlantImport');
const { createImageArchive } = require('../../src/services/imageArchive');
const plants = require('../../src/services/householdPlantService');
const { registerPlantRoutes } = require('../../surfaces/household/plant-routes');
let root, folder, importer, queue, env, original;
async function image(name, format = 'png', color = '#11aa44') {
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: color } })[format]().toBuffer();
  await fs.writeFile(path.join(root, 'photos', 'plants', name), bytes);
  return { name, sha256: sha256(bytes), bytes };
}
const pick = ({ name, sha256: hash }) => ({ name, sha256: hash });
const group = (files, fields = {}) => ({ nickname: 'Synthetic plant', room: 'Salon', files: files.map(pick), ...fields });
beforeEach(async () => {
  await Promise.all([Plant.deleteMany({}), Photo.deleteMany({}), Imports.deleteMany({})]);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plant-import-'));
  await fs.mkdir(path.join(root, 'photos', 'plants'), { recursive: true });
  env = { HOUSEHOLD_IMAGE_MOUNT_BASE: root, HOUSEHOLD_PLANT_IMPORT_DIR: 'plants' };
  folder = createPlantFolder({ env });
  queue = { enroll: jest.fn(async () => ({ id: 'synthetic-queue' })) };
  importer = createPlantImport({ folder, queue, archive: createImageArchive({ dir: path.join(root, 'archive') }) });
  original = await image('salon-fenetre-1.jpg', 'png'); // deliberately wrong extension
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('lists byte-detected JPEG, PNG and WebP, explains HEIC and unsupported data, and bounds file size', async () => {
  await image('bureau.png', 'jpeg'); await image('cuisine.webp', 'webp');
  await fs.writeFile(path.join(root, 'photos/plants/mobile.heic'), Buffer.from('000000186674797068656963000000006d69663168656963', 'hex'));
  await fs.writeFile(path.join(root, 'photos/plants/invalid.jpg'), 'plain text');
  const handle = await fs.open(path.join(root, 'photos/plants/large.png'), 'w');
  await handle.truncate(50 * 1024 * 1024 + 1); await handle.close();
  const result = await importer.list();
  expect(result).toMatchObject({ configured: true, nextOffset: null, truncated: false });
  const byName = Object.fromEntries(result.entries.map(entry => [entry.name, entry]));
  expect(byName[original.name]).toMatchObject({ state: 'available', mimeType: 'image/png', sha256: original.sha256, roomHint: 'Salon' });
  expect(byName['bureau.png'].mimeType).toBe('image/jpeg');
  expect(byName['cuisine.webp'].mimeType).toBe('image/webp');
  expect(byName['mobile.heic']).toMatchObject({ code: 'PLANT_IMPORT_HEIC', message: expect.stringContaining('convertir en JPEG') });
  expect(byName['invalid.jpg'].code).toBe('PLANT_IMPORT_FORMAT');
  expect(byName['large.png'].code).toBe('PLANT_IMPORT_SIZE');
  expect((await folder.rendition(await folder.read('cuisine.webp'))).length).toBeLessThan(2 * 1024 * 1024);
});

test('disabled, missing, empty and paginated folder states are explicit', async () => {
  expect(await createPlantFolder({ env: {} }).list()).toMatchObject({ configured: false, entries: [] });
  env.HOUSEHOLD_PLANT_IMPORT_DIR = 'missing';
  await expect(folder.list()).rejects.toMatchObject({ code: 'PLANT_IMPORT_UNAVAILABLE' });
  env.HOUSEHOLD_PLANT_IMPORT_DIR = 'plants';
  await fs.unlink(path.join(root, 'photos/plants', original.name));
  expect((await folder.list()).entries).toEqual([]);
  for (let i = 0; i < 23; i++) await fs.writeFile(path.join(root, 'photos/plants', `photo-${String(i).padStart(3, '0')}.png`), original.bytes);
  const first = await folder.list();
  expect(first.entries).toHaveLength(20); expect(first.nextOffset).toBe(20);
  expect((await folder.list({ offset: 20 })).entries).toHaveLength(3);
  await expect(folder.list({ offset: '../' })).rejects.toMatchObject({ status: 400 });
});

test('rejects traversal, absolute paths and symlinks escaping either the mount or configured folder', async () => {
  for (const value of ['../photos/plants', '/tmp', 'plants/../plants', 'plants\\other']) {
    env.HOUSEHOLD_PLANT_IMPORT_DIR = value;
    await expect(folder.list()).rejects.toMatchObject({ status: 400 });
  }
  env.HOUSEHOLD_PLANT_IMPORT_DIR = 'plants';
  for (const name of ['../plants/salon-fenetre-1.jpg', '/etc/passwd', '..', 'bad\0.png']) {
    await expect(folder.read(name)).rejects.toMatchObject({ status: 400 });
  }
  await fs.writeFile(path.join(root, 'outside.png'), original.bytes);
  await fs.symlink(path.join(root, 'outside.png'), path.join(root, 'photos/plants/escape.png'));
  await expect(folder.read('escape.png')).rejects.toMatchObject({ status: 400 });
  await fs.symlink(path.join(root, 'photos/plants'), path.join(root, 'photos/alias'));
  env.HOUSEHOLD_PLANT_IMPORT_DIR = 'alias';
  await expect(folder.list()).rejects.toMatchObject({ status: 400 });
});

test('revalidates the displayed hash for thumbnails and import, and rejects corrupt image decoding', async () => {
  const thumb = await importer.thumbnail(pick(original));
  expect((await sharp(thumb.data).metadata()).format).toBe('jpeg');
  await fs.writeFile(path.join(root, 'photos/plants', original.name), 'changed');
  await expect(importer.thumbnail(pick(original))).rejects.toMatchObject({ code: 'PLANT_IMPORT_CHANGED' });
  await expect(importer.importGroup(group([original]))).rejects.toMatchObject({ code: 'PLANT_IMPORT_CHANGED' });
  expect(await Plant.countDocuments()).toBe(0);
  await fs.writeFile(path.join(root, 'photos/plants/broken.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
  const broken = await folder.read('broken.png');
  await expect(importer.importGroup(group([broken]))).rejects.toMatchObject({ code: 'PLANT_IMPORT_DECODE' });
  expect(await Plant.countDocuments()).toBe(0);
});

test('groups originals into one draft through existing photo receipts and keeps originals unchanged', async () => {
  const leaf = await image('salon-feuille.webp', 'webp', '#3399ff');
  const before = await fs.stat(path.join(root, 'photos/plants', original.name));
  const result = await importer.importGroup(group([original, leaf]));
  expect(result.plant).toMatchObject({ status: 'draft', room: 'Salon', identification: null, toxicity: null });
  expect(result.plant.photos).toHaveLength(2);
  expect(queue.enroll).toHaveBeenCalledWith(expect.objectContaining({ imported: true, hashes: expect.arrayContaining([original.sha256, leaf.sha256]) }));
  const receipt = await Imports.findOne().lean();
  expect(receipt.files[0].archive).toMatchObject({ sha256: original.sha256, mimeType: 'image/png', origin: 'uploaded' });
  const archived = await createImageArchive({ dir: path.join(root, 'archive') }).read(receipt.files[0].archive);
  expect(archived.bytes.equals(original.bytes)).toBe(true);
  expect(await plants.list({ view: 'child' })).toEqual({ plants: [] });
  await expect(plants.get({ id: result.plant.id, view: 'child' })).rejects.toMatchObject({ status: 404 });
  await expect(plants.photo({ id: result.plant.id, photoId: result.plant.photos[0].id })).rejects.toMatchObject({ status: 404 });
  expect((await plants.photo({ id: result.plant.id, photoId: result.plant.photos[0].id, view: 'manage' })).mimeType).toBe('image/jpeg');
  expect((await fs.readFile(path.join(root, 'photos/plants', original.name))).equals(original.bytes)).toBe(true);
  const after = await fs.stat(path.join(root, 'photos/plants', original.name));
  expect(after.mtimeMs).toBe(before.mtimeMs); expect(after.ino).toBe(before.ino);
  expect((await importer.list()).entries.every(entry => entry.state === 'imported')).toBe(true);
});

test('concurrent retries create one card and one receipt per photo; overlapping groups cannot claim a photo twice', async () => {
  const leaf = await image('leaf.webp', 'webp', '#aa33dd');
  const input = group([original, leaf]);
  const results = await Promise.all(Array.from({ length: 5 }, () => importer.importGroup(input)));
  expect(new Set(results.map(result => result.plant.id)).size).toBe(1);
  expect(await Plant.countDocuments()).toBe(1); expect(await Photo.countDocuments()).toBe(2);
  const repeated = await importer.importGroup(group([leaf, original]));
  expect(repeated).toMatchObject({ duplicate: true, plant: { id: results[0].plant.id } });
  await fs.writeFile(path.join(root, 'photos/plants/renamed.png'), original.bytes);
  await expect(importer.importGroup(group([{ ...original, name: 'renamed.png' }]))).rejects.toMatchObject({ code: 'PLANT_IMPORT_GROUP_CONFLICT' });
  expect(await Plant.countDocuments()).toBe(1);
});

test('resumes a partial import and reports queue unavailability while keeping a parent draft', async () => {
  const addPhoto = jest.spyOn(plants, 'addPhoto').mockRejectedValueOnce(new Error('synthetic interruption'));
  await expect(importer.importGroup(group([original]))).rejects.toThrow('synthetic interruption');
  expect(await Plant.countDocuments()).toBe(1);
  expect((await importer.list()).entries[0].state).toBe('incomplete');
  addPhoto.mockRestore();
  queue.enroll.mockRejectedValueOnce(Object.assign(new Error('migration needed'), { code: 'HEAVY_QUEUE_MIGRATION_REQUIRED' }));
  const retried = await importer.importGroup(group([original]));
  expect(retried.plant.assistant.identify).toMatchObject({ state: 'queued', error: 'HEAVY_QUEUE_MIGRATION_REQUIRED' });
  const { createPlantAssistant } = require('../../src/services/householdPlantAssistant');
  const execute = jest.fn();
  const assistant = createPlantAssistant({ inference: { execute }, consumerContract: 'household-runtime-v1' });
  await expect(assistant.identify({ id: retried.plant.id })).rejects.toMatchObject({ code: 'PLANT_ASSIST_QUEUED' });
  expect(execute).not.toHaveBeenCalled();
  expect(retried).toMatchObject({ plant: { status: 'draft' }, planningError: 'HEAVY_QUEUE_MIGRATION_REQUIRED' });
  expect(await Plant.countDocuments()).toBe(1); expect(await Photo.countDocuments()).toBe(1);
  expect(await plants.list({ view: 'child' })).toEqual({ plants: [] });
});

test('HTTP import and thumbnail routes precede plant ids and retain child projection isolation', async () => {
  const app = express();
  registerPlantRoutes({ app, express, plants, importer, standardJsonParser: express.json() });
  await request(app).get('/api/family/plants/import-folder').expect(200).expect(result => {
    expect(result.body.data.entries[0].sha256).toBe(original.sha256);
  });
  await request(app).get('/api/family/plants/import-folder/thumbnail').query(pick(original)).expect('Content-Type', /image\/jpeg/).expect('Cache-Control', 'no-store').expect(200);
  const created = await request(app).post('/api/family/plants/import-folder').send(group([original])).expect(201);
  await request(app).get('/api/family/plants?view=child').expect(200).expect(result => expect(result.body.data.plants).toEqual([]));
  const photo = created.body.data.plant.photos[0];
  await request(app).get(photo.url).expect(404);
  await request(app).get(photo.url + '?view=manage').expect(200);
});

test('different concurrent groups cannot both own the same original', async () => {
  const leaf = await image('leaf.png', 'png', '#ff2200');
  const results = await Promise.allSettled([importer.importGroup(group([original])), importer.importGroup(group([original, leaf]))]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason.code).toBe('PLANT_IMPORT_GROUP_CONFLICT');
  expect(await Plant.countDocuments()).toBe(1); expect(await Imports.countDocuments()).toBe(1);
});

test('large folders report the hard listing bound without unbounded discovery', async () => {
  await Promise.all(Array.from({ length: 501 }, (_, index) => fs.writeFile(path.join(root, 'photos/plants', `synthetic-${index}.txt`), 'x')));
  const result = await folder.list();
  expect(result.truncated).toBe(true); expect(result.entries).toHaveLength(20);
  expect(result.nextOffset).toBe(20);
});

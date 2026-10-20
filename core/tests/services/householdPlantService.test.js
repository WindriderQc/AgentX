'use strict';

const Plant = require('../../models/HouseholdPlant');
const PlantPhoto = require('../../models/HouseholdPlantPhoto');
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');

// A 1x1 PNG and a minimal JPEG header: synthetic, never household photos.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(32, 1)]);
const dataUrl = (bytes, type) => `data:${type};base64,${bytes.toString('base64')}`;
const toxic = { level: 'toxic', sources: ['https://example.org/toxicity'] };
const card = {
  identification: { commonName: 'Pothos', latinName: 'Epipremnum aureum', confidence: 0.9, source: 'model', model: 'synthetic' },
  careSheet: { light: { text: 'Bright, indirect', sources: ['https://example.org/light'] }, water: { text: 'When the top is dry' } },
  toxicity: { children: toxic, cats: toxic, dogs: toxic, reviewed: true },
  carePlan: [{ title: 'Water the synthetic plant', cadence: 'interval', intervalDays: 7, winterIntervalDays: 14, stars: 2 }]
};

describe('household plant cards in Core', () => {
  const { plants } = createTrustedRuntimeServices().household;
  beforeEach(async () => { await Promise.all([Plant.deleteMany({}), PlantPhoto.deleteMany({})]); });

  test('a draft becomes a published card only after its species, reviewed toxicity and care plan are set', async () => {
    const { plant: draft } = await plants.create({ nickname: 'Synthetic plant', room: 'Salon' });
    expect(draft).toMatchObject({ status: 'draft', revision: 0, problems: ['species', 'toxicity', 'care_plan'] });
    await expect(plants.publish({ id: draft.id, expectedRevision: 0 })).rejects.toMatchObject({ status: 409, code: 'PLANT_NOT_READY', details: { problems: ['species', 'toxicity', 'care_plan'] } });
    expect((await plants.list({})).plants).toEqual([]);
    await expect(plants.get({ id: draft.id })).rejects.toMatchObject({ status: 404 });

    const { plant: filled } = await plants.update({ id: draft.id, expectedRevision: 0, ...card });
    expect(filled).toMatchObject({ revision: 1, problems: [] });
    await expect(plants.update({ id: draft.id, expectedRevision: 0, funFact: 'Stale edit' })).rejects.toMatchObject({ status: 409, code: 'PLANT_EDIT_CONFLICT' });
    const { plant: published } = await plants.publish({ id: draft.id, expectedRevision: 1 });
    expect(published).toMatchObject({ status: 'published', revision: 2 });
    expect(published.publishedAt).toBeTruthy();
    expect(await plants.publish({ id: draft.id, expectedRevision: 2 })).toMatchObject({ alreadyPublished: true });

    const childList = (await plants.list({ view: 'child' })).plants;
    expect(childList).toEqual([expect.objectContaining({ nickname: 'Synthetic plant', commonName: 'Pothos', doNotEat: true,
      needs: { light: 'Bright, indirect', water: 'When the top is dry' } })]);
    expect(JSON.stringify(childList)).not.toMatch(/example\.org|reviewed|carePlan|candidates/);
  });

  test('a published card cannot lose what the children rely on, and a retired card is frozen', async () => {
    const { plant } = await plants.create({ nickname: 'Synthetic plant', ...card });
    await plants.publish({ id: plant.id, expectedRevision: 0 });
    await expect(plants.update({ id: plant.id, expectedRevision: 1, carePlan: [] })).rejects.toMatchObject({ code: 'PLANT_NOT_READY' });
    // Editing toxicity without confirming it again would hide the review: refused on a published card.
    await expect(plants.update({ id: plant.id, expectedRevision: 1, toxicity: { ...card.toxicity, reviewed: false } }))
      .rejects.toMatchObject({ code: 'PLANT_NOT_READY', details: { problems: ['toxicity_review'] } });
    const { plant: edited } = await plants.update({ id: plant.id, expectedRevision: 1, funFact: 'It climbs trees.' });
    expect(edited).toMatchObject({ status: 'published', funFact: 'It climbs trees.', revision: 2 });
    const { plant: retired } = await plants.retire({ id: plant.id, expectedRevision: 2 });
    expect(retired.status).toBe('retired');
    await expect(plants.update({ id: plant.id, expectedRevision: 3, funFact: 'x' })).rejects.toMatchObject({ code: 'PLANT_RETIRED' });
    expect((await plants.list({ view: 'child' })).plants).toEqual([]);
    expect((await plants.list({ view: 'manage' })).plants).toEqual([]);
    expect((await plants.list({ view: 'manage', includeRetired: 'true' })).plants).toHaveLength(1);
  });

  test('photos are validated, kept once, bounded, served to children only once published, and removable', async () => {
    const { plant } = await plants.create({ nickname: 'Synthetic plant' });
    await expect(plants.addPhoto({ id: plant.id, expectedRevision: 0, dataUrl: dataUrl(Buffer.from('not an image'), 'image/png') }))
      .rejects.toMatchObject({ code: 'PLANT_PHOTO_INVALID' });
    await expect(plants.addPhoto({ id: plant.id, expectedRevision: 0, dataUrl: dataUrl(PNG, 'image/gif') })).rejects.toMatchObject({ code: 'PLANT_PHOTO_INVALID' });
    await expect(plants.addPhoto({ id: plant.id, expectedRevision: 0, bytes: Buffer.alloc(2 * 1024 * 1024 + 1, 0xff), mimeType: 'image/jpeg' }))
      .rejects.toMatchObject({ status: 413 });
    const { plant: withPng } = await plants.addPhoto({ id: plant.id, expectedRevision: 0, dataUrl: dataUrl(PNG, 'image/png') });
    expect(withPng.photos).toHaveLength(1);
    expect(await plants.addPhoto({ id: plant.id, expectedRevision: 1, dataUrl: dataUrl(PNG, 'image/png') })).toMatchObject({ duplicate: true });
    // Bytes a Core caller already holds (for example a conversation attachment) use the same path.
    const { plant: withJpeg } = await plants.addPhoto({ id: plant.id, expectedRevision: 1, bytes: JPEG, mimeType: 'image/jpeg' });
    expect(withJpeg.photos.map(photo => photo.mimeType)).toEqual(['image/png', 'image/jpeg']);

    const photoId = withJpeg.photos[0].id;
    await expect(plants.photo({ id: plant.id, photoId })).rejects.toMatchObject({ status: 404 });
    const served = await plants.photo({ id: plant.id, photoId, view: 'manage' });
    expect(served.mimeType).toBe('image/png'); expect(served.data.equals(PNG)).toBe(true);

    for (let index = 0; index < 2; index += 1) {
      const current = (await plants.get({ id: plant.id, view: 'manage' })).plant;
      await plants.addPhoto({ id: plant.id, expectedRevision: current.revision, bytes: Buffer.concat([JPEG, Buffer.from([index])]), mimeType: 'image/jpeg' });
    }
    const full = (await plants.get({ id: plant.id, view: 'manage' })).plant;
    await expect(plants.addPhoto({ id: plant.id, expectedRevision: full.revision, bytes: Buffer.concat([JPEG, Buffer.from([9])]), mimeType: 'image/jpeg' }))
      .rejects.toMatchObject({ code: 'PLANT_PHOTO_LIMIT' });
    const { plant: removed } = await plants.removePhoto({ id: plant.id, photoId, expectedRevision: full.revision });
    expect(removed.photos).toHaveLength(3);
    expect(await PlantPhoto.countDocuments({ plantId: plant.id })).toBe(3);
    await expect(plants.photo({ id: plant.id, photoId, view: 'manage' })).rejects.toMatchObject({ code: 'PLANT_PHOTO_NOT_FOUND' });
  });

  test('ids, revisions and unknown fields are refused before any write', async () => {
    await expect(plants.get({ id: '../etc', view: 'manage' })).rejects.toMatchObject({ code: 'PLANT_BAD_ID' });
    await expect(plants.get({ id: '0123456789abcdef01234567', view: 'manage' })).rejects.toMatchObject({ status: 404 });
    const { plant } = await plants.create({ nickname: 'Synthetic plant' });
    await expect(plants.update({ id: plant.id, expectedRevision: '0', funFact: 'x' })).rejects.toMatchObject({ code: 'PLANT_REVISION_REQUIRED' });
    await expect(plants.update({ id: plant.id, expectedRevision: 0, status: 'published' })).rejects.toMatchObject({ status: 400 });
    await expect(plants.update({ id: plant.id, expectedRevision: 0 })).rejects.toMatchObject({ code: 'PLANT_EDIT_EMPTY' });
    await expect(plants.create({ room: 'Salon' })).rejects.toMatchObject({ code: 'PLANT_NICKNAME_REQUIRED' });
    expect(await Plant.countDocuments({})).toBe(1);
  });

  test('a published card is filed in the vault inbox as a Plante note; drafts are not (#871)', async () => {
    const fs = require('fs/promises'), os = require('os'), path = require('path');
    const { createVaultInbox } = require('../../src/services/vaultInboxService');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plant-vault-'));
    try {
      const vaultInbox = createVaultInbox({ root });
      const { plant } = await plants.create({ nickname: 'Synthetic plant', ...card });
      await expect(plants.exportToVault({ id: plant.id }, { vaultInbox })).rejects.toMatchObject({ status: 409, code: 'PLANT_NOT_PUBLISHED' });
      const { plant: published } = await plants.publish({ id: plant.id, expectedRevision: 0 });
      const exported = await plants.exportToVault({ id: plant.id }, { vaultInbox });
      expect(exported).toMatchObject({ status: 'inbox', file: expect.stringMatching(/Plante — Synthetic plant\.md$/) });
      const text = await fs.readFile(path.join(root, exported.file), 'utf8');
      expect(text).toContain('author: household');
      expect(text).toContain('type: "plante"');
      expect(text).toContain(`plant_id: "${plant.id}"`);
      expect(text).toContain('## Toxicité');
      // Exporting changes nothing on the card.
      expect((await plants.get({ id: plant.id, view: 'manage' })).plant.revision).toBe(published.revision);
      await expect(plants.exportToVault({ id: plant.id }, { vaultInbox: createVaultInbox({ root: '' }) }))
        .rejects.toMatchObject({ status: 503, code: 'VAULT_INBOX_DISABLED' });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

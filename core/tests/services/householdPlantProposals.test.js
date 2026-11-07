'use strict';

// Children's plant proposals (#876). Synthetic profiles and a 1x1 PNG only:
// no household photo and no real identification is ever used here.
const Plant = require('../../models/HouseholdPlant');
const PlantPhoto = require('../../models/HouseholdPlantPhoto');
const Profile = require('../../models/HouseholdProfile');
const plants = require('../../src/services/householdPlantService');
const proposals = require('../../src/services/householdPlantProposals');
const { createPlantAssistant } = require('../../src/services/householdPlantAssistant');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const dataUrl = (bytes = PNG, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`;
// A distinct synthetic PNG per call, so photos never collide on their hash.
const uniquePng = index => Buffer.concat([PNG, Buffer.from(`synthetic-${index}`)]);
const toxic = { level: 'toxic', sources: ['https://example.org/toxicity'] };
const card = {
  identification: { commonName: 'Synthetic pothos', source: 'parent' },
  careSheet: { water: { text: 'When the top is dry' } },
  toxicity: { children: toxic, cats: toxic, dogs: toxic, reviewed: true },
  carePlan: [{ title: 'Water the synthetic plant', cadence: 'interval', intervalDays: 7 }]
};
const childA = 'synthetic-child-a', childB = 'synthetic-child-b';

describe('children propose a plant for parent validation (#876)', () => {
  beforeAll(() => proposals.ensureIndexes());
  beforeEach(async () => {
    await Promise.all([Plant.deleteMany({}), PlantPhoto.deleteMany({}), Profile.deleteMany({})]);
    await Profile.create([
      { profileId: childA, displayName: 'Synthetic A', ageBand: 'school' },
      { profileId: childB, displayName: 'Synthetic B', ageBand: 'little' },
      { profileId: 'synthetic-retired', displayName: 'Retired', active: false }
    ]);
  });

  test('a proposal is a draft attributed to the child, published only by the parent', async () => {
    expect(await proposals.status({ profileId: childA })).toEqual({ rooms: expect.arrayContaining(['Salon', 'Cuisine']), proposal: null });
    const { proposal } = await proposals.propose({ profileId: childA, room: 'Salon', dataUrl: dataUrl() });
    expect(proposal).toMatchObject({ state: 'pending', room: 'Salon', reply: null, plant: null,
      photoUrl: `/api/family/plant-proposals/${proposal.id}/photo?profileId=${childA}` });

    const stored = await Plant.findById(proposal.id).lean();
    expect(stored).toMatchObject({ status: 'draft', nickname: 'Plante de Synthetic A', room: 'Salon',
      proposal: { proposedBy: childA, open: true, state: 'pending' } });
    expect(stored.photos).toHaveLength(1);
    expect(stored.assistant?.identify?.state).toBeUndefined();

    // Never in Ma jungle before the parent publishes; first in the parent's list.
    expect((await plants.list({ view: 'child' })).plants).toEqual([]);
    await expect(plants.get({ id: proposal.id })).rejects.toMatchObject({ status: 404 });
    await expect(plants.photo({ id: proposal.id, photoId: String(stored.photos[0]._id) })).rejects.toMatchObject({ status: 404 });
    await plants.create({ nickname: 'Another draft' });
    const managed = (await plants.list({ view: 'manage' })).plants;
    expect(managed[0]).toMatchObject({ id: proposal.id, proposal: { proposedBy: childA, state: 'pending', open: true } });

    const opened = await proposals.open({ id: proposal.id });
    expect(opened).toMatchObject({ opened: true, plant: { proposal: { state: 'opened', open: true } } });
    expect((await proposals.status({ profileId: childA })).proposal).toMatchObject({ state: 'opened' });

    const { plant: filled } = await plants.update({ id: proposal.id, expectedRevision: opened.plant.revision, nickname: 'Synthetic fern', ...card });
    const { plant: published } = await plants.publish({ id: proposal.id, expectedRevision: filled.revision });
    expect(published).toMatchObject({ status: 'published', proposal: { state: 'accepted', open: false } });
    expect((await plants.list({ view: 'child' })).plants.map(plant => plant.nickname)).toEqual(['Synthetic fern']);

    const answered = (await proposals.status({ profileId: childA })).proposal;
    expect(answered).toMatchObject({ state: 'accepted', plant: { id: proposal.id, nickname: 'Synthetic fern' } });
    expect(JSON.stringify(answered)).not.toMatch(/example\.org|toxicity|carePlan|candidates|revision/);
    // Acknowledged answers disappear; the child can propose again.
    expect(await proposals.seen({ id: proposal.id, profileId: childA })).toMatchObject({ proposal: null });
    expect(await proposals.seen({ id: proposal.id, profileId: childA })).toMatchObject({ proposal: null });
    await expect(proposals.propose({ profileId: childA, dataUrl: dataUrl(uniquePng(2)) })).resolves.toMatchObject({ proposal: { state: 'pending', room: null } });
  });

  test('a declined proposal returns the parent\'s short reply to the child', async () => {
    const { proposal } = await proposals.propose({ profileId: childA, dataUrl: dataUrl() });
    const { plant } = await proposals.open({ id: proposal.id });
    await expect(proposals.decline({ id: proposal.id, expectedRevision: plant.revision - 1, reply: 'Stale' }))
      .rejects.toMatchObject({ status: 409, code: 'PLANT_EDIT_CONFLICT' });
    const { plant: declined } = await proposals.decline({ id: proposal.id, expectedRevision: plant.revision,
      reply: '  Papa a vu ta plante.\n On la regardera ensemble !  ' });
    expect(declined).toMatchObject({ status: 'retired', proposal: { state: 'declined', open: false, reply: 'Papa a vu ta plante. On la regardera ensemble !' } });
    expect((await proposals.status({ profileId: childA })).proposal).toMatchObject({ state: 'declined', reply: 'Papa a vu ta plante. On la regardera ensemble !', plant: null });
    await expect(proposals.decline({ id: proposal.id, expectedRevision: declined.revision })).rejects.toMatchObject({ status: 409, code: 'PLANT_PROPOSAL_CLOSED' });
    await expect(proposals.open({ id: proposal.id })).resolves.toMatchObject({ opened: false });

    // Discarding a proposal from the card answers the child too, with the default reply.
    await proposals.seen({ id: proposal.id, profileId: childA });
    const second = (await proposals.propose({ profileId: childA, dataUrl: dataUrl(uniquePng(3)) })).proposal;
    const current = (await plants.get({ id: second.id, view: 'manage' })).plant;
    await plants.retire({ id: second.id, expectedRevision: current.revision });
    expect((await proposals.status({ profileId: childA })).proposal).toMatchObject({ id: second.id, state: 'declined', reply: 'Papa a vu ta plante. Merci !' });
    // A plain parent draft is not a proposal.
    const { plant: draft } = await plants.create({ nickname: 'Parent draft' });
    await expect(proposals.open({ id: draft.id })).rejects.toMatchObject({ status: 409, code: 'PLANT_NOT_PROPOSAL' });
    await expect(proposals.decline({ id: draft.id, expectedRevision: 0 })).rejects.toMatchObject({ status: 409, code: 'PLANT_PROPOSAL_CLOSED' });
  });

  test('identification waits until a parent opens the proposal, and starts once', async () => {
    const execute = jest.fn(async () => ({ ok: true, body: { message: { content: JSON.stringify({ candidates: [] }) } }, metadata: { model: 'synthetic-vision' } }));
    const assistant = createPlantAssistant({ inference: { execute }, consumerContract: 'household-runtime-v1' });
    const { proposal } = await proposals.propose({ profileId: childA, dataUrl: dataUrl() });
    await expect(assistant.identify({ id: proposal.id, wait: true })).rejects.toMatchObject({ status: 409, code: 'PLANT_PROPOSAL_UNOPENED' });
    expect(execute).not.toHaveBeenCalled();
    const openings = await Promise.all([proposals.open({ id: proposal.id }), proposals.open({ id: proposal.id }), proposals.open({ id: proposal.id })]);
    expect(openings.filter(result => result.opened)).toHaveLength(1);
    const { plant } = await assistant.identify({ id: proposal.id, wait: true });
    expect(plant.assistant.identify).toMatchObject({ state: 'completed', candidates: [] });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('bounds: one waiting proposal per child, a photo of 2 MB or less, no text beyond the room', async () => {
    await proposals.propose({ profileId: childA, dataUrl: dataUrl() });
    await expect(proposals.propose({ profileId: childA, dataUrl: dataUrl(uniquePng(1)) })).rejects.toMatchObject({ status: 409, code: 'PLANT_PROPOSAL_PENDING' });
    // Another child is not blocked.
    await expect(proposals.propose({ profileId: childB, room: 'Cuisine', dataUrl: dataUrl() })).resolves.toMatchObject({ proposal: { state: 'pending' } });

    const tooLarge = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const fresh = 'synthetic-child-c';
    await Profile.create({ profileId: fresh, displayName: 'Synthetic C' });
    await expect(proposals.propose({ profileId: fresh, dataUrl: dataUrl(tooLarge) })).rejects.toMatchObject({ status: 413, code: 'PLANT_PHOTO_TOO_LARGE' });
    await expect(proposals.propose({ profileId: fresh, dataUrl: dataUrl(Buffer.from('not an image'), 'image/png') })).rejects.toMatchObject({ status: 400, code: 'PLANT_PHOTO_INVALID' });
    await expect(proposals.propose({ profileId: fresh, dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })).rejects.toMatchObject({ status: 400, code: 'PLANT_PHOTO_INVALID' });
    await expect(proposals.propose({ profileId: fresh })).rejects.toMatchObject({ status: 400, code: 'PLANT_PHOTO_INVALID' });
    for (const extra of [{ nickname: 'Free text' }, { note: 'Free text' }, { spot: 'Near the window' }, { commonName: 'Pothos' }]) {
      await expect(proposals.propose({ profileId: fresh, dataUrl: dataUrl(), ...extra })).rejects.toMatchObject({ status: 400, code: 'PLANT_PROPOSAL_INVALID' });
    }
    await expect(proposals.propose({ profileId: fresh, room: 'Le grenier secret', dataUrl: dataUrl() })).rejects.toMatchObject({ status: 400, code: 'PLANT_PROPOSAL_INVALID' });
    await expect(proposals.propose({ profileId: '', dataUrl: dataUrl() })).rejects.toMatchObject({ status: 400, code: 'PLANT_PROPOSAL_PROFILE_REQUIRED' });
    for (const profileId of ['synthetic-unknown', 'synthetic-retired']) {
      await expect(proposals.propose({ profileId, dataUrl: dataUrl() })).rejects.toMatchObject({ status: 404, code: 'PLANT_PROPOSAL_PROFILE_UNKNOWN' });
    }
    // Nothing refused left a card or a photo behind.
    expect(await Plant.countDocuments({ 'proposal.proposedBy': fresh })).toBe(0);
    expect(await PlantPhoto.countDocuments({})).toBe(2);
  });

  test('a child reads and acknowledges only their own proposal', async () => {
    const { proposal } = await proposals.propose({ profileId: childA, dataUrl: dataUrl() });
    expect((await proposals.status({ profileId: childB })).proposal).toBeNull();
    const own = await proposals.photo({ id: proposal.id, profileId: childA });
    expect(own).toMatchObject({ mimeType: 'image/png' });
    expect(Buffer.compare(own.data, PNG)).toBe(0);
    await expect(proposals.photo({ id: proposal.id, profileId: childB })).rejects.toMatchObject({ status: 404, code: 'PLANT_PROPOSAL_NOT_FOUND' });
    await expect(proposals.seen({ id: proposal.id, profileId: childB })).rejects.toMatchObject({ status: 404, code: 'PLANT_PROPOSAL_NOT_FOUND' });
    await expect(proposals.seen({ id: proposal.id, profileId: childA })).rejects.toMatchObject({ status: 409, code: 'PLANT_PROPOSAL_WAITING' });
    await expect(proposals.photo({ id: 'not-an-id', profileId: childA })).rejects.toMatchObject({ status: 400, code: 'PLANT_BAD_ID' });
    const { plant: draft } = await plants.create({ nickname: 'Parent draft' });
    await expect(proposals.photo({ id: draft.id, profileId: childA })).rejects.toMatchObject({ status: 404, code: 'PLANT_PROPOSAL_NOT_FOUND' });
    await expect(proposals.status({ profileId: 'synthetic-unknown' })).rejects.toMatchObject({ status: 404 });
  });

  test('racing proposals from one child keep exactly one, with no orphan photo', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      proposals.propose({ profileId: childA, dataUrl: dataUrl(uniquePng(index)) })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason.code))
      .toEqual(Array(5).fill('PLANT_PROPOSAL_PENDING'));
    expect(await Plant.countDocuments({ 'proposal.proposedBy': childA })).toBe(1);
    expect(await PlantPhoto.countDocuments({})).toBe(1);
  });

  test('racing parent answers settle once: publish and decline cannot both win', async () => {
    const { proposal } = await proposals.propose({ profileId: childA, dataUrl: dataUrl() });
    const { plant: opened } = await proposals.open({ id: proposal.id });
    const { plant: ready } = await plants.update({ id: proposal.id, expectedRevision: opened.revision, ...card });
    const [publish, decline] = await Promise.allSettled([
      plants.publish({ id: proposal.id, expectedRevision: ready.revision }),
      proposals.decline({ id: proposal.id, expectedRevision: ready.revision })
    ]);
    expect([publish.status, decline.status].sort()).toEqual(['fulfilled', 'rejected']);
    const stored = await Plant.findById(proposal.id).lean();
    expect(stored.proposal.open).toBeUndefined();
    expect(stored.status === 'published' ? 'accepted' : 'declined').toBe(stored.proposal.state);
  });
});

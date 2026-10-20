'use strict';

const Plant = require('../../models/HouseholdPlant');
const PlantPhoto = require('../../models/HouseholdPlantPhoto');
const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const Profile = require('../../models/HouseholdProfile');
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');

const toxic = { level: 'toxic', sources: [] };
const card = (carePlan) => ({ nickname: 'Synthetic plant',
  identification: { commonName: 'Pothos', source: 'parent' },
  toxicity: { children: toxic, cats: toxic, dogs: toxic, reviewed: true }, carePlan });
const water = { key: 'water', title: 'Arroser la plante', note: 'Un verre', cadence: 'interval', intervalDays: 7, stars: 2, minAgeBand: 'school', profileId: 'sample-child' };
const turn = { key: 'turn', title: 'Tourner le pot', cadence: 'weekly', stars: 1, minAgeBand: 'school', profileId: null };

describe('plant care plans drive linked Kids Room chores (#869)', () => {
  const { household: { plants }, tasks: { family } } = createTrustedRuntimeServices();
  const plantChores = async () => PipelineTask.find({ service: 'family', subjectRef: { $regex: /^plant:/ } }).sort({ pipelineId: 1 }).lean();
  beforeEach(async () => {
    await Promise.all([Plant.deleteMany({}), PlantPhoto.deleteMany({}), PipelineTask.deleteMany({}), Counter.deleteMany({}), Profile.deleteMany({})]);
    await family.addProfile({ profileId: 'sample-child', displayName: 'Sample child', ageBand: 'school' });
    await family.addProfile({ profileId: 'other-child', displayName: 'Other child', ageBand: 'teen' });
  });

  test('publishing creates one chore per assigned action, due today, and the child card shows its mood', async () => {
    const { plant } = await plants.create(card([water, turn]));
    expect(await plantChores()).toHaveLength(0);
    const published = await plants.publish({ id: plant.id, expectedRevision: 0 });
    expect(published.chores).toMatchObject({ created: [expect.any(String)], unassigned: ['Tourner le pot'], errors: [] });
    const [chore] = await plantChores();
    expect(chore).toMatchObject({ title: 'Arroser la plante', spec: 'Un verre', profileId: 'sample-child', cadence: 'interval', intervalDays: 7,
      stars: 2, status: 'queued', source: 'household-plant', sourceKey: `plant:${plant.id}:water`, subjectRef: `plant:${plant.id}` });
    const child = (await plants.get({ id: plant.id })).plant;
    expect(child).toMatchObject({ mood: 'thirsty', care: [{ ref: chore.pipelineId, title: 'Arroser la plante', profileId: 'sample-child', dueToday: true, waiting: false }] });
    // The chore is an ordinary Kids Room chore: the child checks it in, the plant waits for the parent.
    await family.checkIn({ ref: chore.pipelineId, profileId: 'sample-child' });
    expect((await plants.list({})).plants[0].mood).toBe('waiting');
    await family.approve({ ref: chore.pipelineId });
    expect((await plants.list({})).plants[0].mood).toBe('happy');
    expect((await family.room({ profileId: 'sample-child' })).room.available).toHaveLength(0);
  });

  test('plan edits update, add and cancel open chores, never one a child has checked in', async () => {
    const { plant } = await plants.create(card([water, { ...turn, profileId: 'other-child' }]));
    let { plant: current } = await plants.publish({ id: plant.id, expectedRevision: 0 });
    const [watering, turning] = await plantChores();
    await family.checkIn({ ref: turning.pipelineId, profileId: 'other-child' });
    const edited = await plants.update({ id: plant.id, expectedRevision: current.revision, carePlan: [
      { ...water, title: 'Arroser Gérard', stars: 3, profileId: 'other-child' },
      { ...turn, title: 'Tourner le pot doucement', profileId: 'other-child' },
      { key: 'dust', title: 'Dépoussiérer les feuilles', cadence: 'interval', intervalDays: 30, stars: 3, minAgeBand: 'school', profileId: 'sample-child' }] });
    expect(edited.chores).toMatchObject({ updated: [watering.pipelineId], waiting: [turning.pipelineId], created: [expect.any(String)], errors: [] });
    const rows = await plantChores();
    expect(rows.find(row => row.pipelineId === watering.pipelineId)).toMatchObject({ title: 'Arroser Gérard', stars: 3, profileId: 'other-child', status: 'queued' });
    expect(rows.find(row => row.pipelineId === turning.pipelineId)).toMatchObject({ title: 'Tourner le pot', status: 'review' });
    expect(rows.find(row => row.sourceKey === `plant:${plant.id}:dust`)).toMatchObject({ profileId: 'sample-child', intervalDays: 30 });

    current = edited.plant;
    const removed = await plants.update({ id: plant.id, expectedRevision: current.revision, carePlan: [{ ...water, profileId: null }] });
    expect(removed.chores.cancelled).toEqual(expect.arrayContaining([watering.pipelineId]));
    expect(removed.chores.unassigned).toEqual(['Arroser la plante']);
    expect((await PipelineTask.findOne({ pipelineId: watering.pipelineId }).lean()).familyCancelled).toBe(true);

    // Assigning the action again brings the same chore back rather than a duplicate.
    const back = await plants.update({ id: plant.id, expectedRevision: removed.plant.revision, carePlan: [water] });
    expect(back.chores.updated).toEqual([watering.pipelineId]);
    const restored = await PipelineTask.findOne({ pipelineId: watering.pipelineId }).lean();
    expect(restored).toMatchObject({ status: 'queued', familyCancelled: false, profileId: 'sample-child' });
    expect(await PipelineTask.countDocuments({ sourceKey: `plant:${plant.id}:water` })).toBe(1);
  });

  test('retiring a plant cancels its open chores; drafts never create chores', async () => {
    const { plant } = await plants.create(card([water]));
    const draftEdit = await plants.update({ id: plant.id, expectedRevision: 0, funFact: 'Draft only' });
    expect(draftEdit.chores).toBeUndefined();
    expect(await plantChores()).toHaveLength(0);
    const { plant: published } = await plants.publish({ id: plant.id, expectedRevision: 1 });
    const retired = await plants.retire({ id: plant.id, expectedRevision: published.revision });
    expect(retired.chores.cancelled).toHaveLength(1);
    expect((await plantChores())[0]).toMatchObject({ familyCancelled: true });
    expect((await family.room({ profileId: 'sample-child' })).room.available).toHaveLength(0);
  });

  test('a chore that cannot be created is reported, and the card is still saved', async () => {
    const { plant } = await plants.create(card([{ ...water, profileId: 'archived-child' }]));
    const published = await plants.publish({ id: plant.id, expectedRevision: 0 });
    expect(published.plant.status).toBe('published');
    expect(published.chores.errors).toEqual([{ title: 'Arroser la plante', code: 'FAMILY_PROFILE_NOT_FOUND' }]);
  });
});

'use strict';

// Household plant cards (#866). Core owns the card, its photos and its review
// state; surfaces translate HTTP and agents only draft. Every edit is bound to
// the revision the parent saw. Children read published cards only.
const mongoose = require('mongoose');
const Plant = require('../../models/HouseholdPlant');
const PlantPhoto = require('../../models/HouseholdPlantPhoto');
const content = require('../helpers/fileContentChecks');
const { LIMITS, childPlant, managedPlant, plantInput, publishProblems } = require('../domains/household/plants');

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png']);
const failure = (status, code, message, details) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

function plantId(value) {
  const id = String(value ?? '').trim();
  if (!mongoose.isValidObjectId(id) || !/^[a-f0-9]{24}$/.test(id)) throw failure(400, 'PLANT_BAD_ID', 'plant id is invalid');
  return id;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 0) throw failure(400, 'PLANT_REVISION_REQUIRED', 'An exact expectedRevision is required');
  return value;
}

const view = value => value === 'manage' ? 'manage' : 'child';
const project = (plant, as) => as === 'manage' ? managedPlant(plant) : childPlant(plant);

async function find(id) {
  const plant = await Plant.findById(plantId(id)).lean();
  if (!plant) throw failure(404, 'PLANT_NOT_FOUND', 'Plant not found');
  return plant;
}

// One revision-bound write. A stale revision is a conflict, never a silent overwrite.
async function write(id, expectedRevision, set, extra = {}) {
  const current = await find(id);
  if (current.__v !== revision(expectedRevision)) throw failure(409, 'PLANT_EDIT_CONFLICT', 'This plant changed. Refresh before editing it.');
  const saved = await Plant.findOneAndUpdate({ _id: current._id, __v: expectedRevision },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...extra, $inc: { __v: 1 } }, { new: true, runValidators: true }).lean();
  if (!saved) throw failure(409, 'PLANT_EDIT_CONFLICT', 'This plant changed. Refresh before editing it.');
  return saved;
}

function assertEditable(plant) {
  if (plant.status === 'retired') throw failure(409, 'PLANT_RETIRED', 'This plant is retired.');
}

function assertPublishable(plant) {
  const problems = publishProblems(plant);
  if (problems.length) throw failure(409, 'PLANT_NOT_READY', `The card is not ready: ${problems.join(', ')}`, { problems });
}

async function create(input = {}) {
  const fields = plantInput(input, { create: true });
  const plant = await Plant.create({ ...fields, status: 'draft' });
  return { plant: managedPlant(plant.toObject()) };
}

async function list(input = {}) {
  const as = view(input.view);
  const query = as === 'child' ? { status: 'published' }
    : String(input.includeRetired || '') === 'true' ? {} : { status: { $ne: 'retired' } };
  const rows = await Plant.find(query).sort({ nickname: 1 }).limit(200).lean();
  // Parents see what needs them first: drafts, then the rest by name.
  if (as === 'manage') rows.sort((a, b) => Number(a.status !== 'draft') - Number(b.status !== 'draft'));
  return { plants: rows.map(row => project(row, as)) };
}

async function get(input = {}) {
  const as = view(input.view);
  const plant = await find(input.id);
  if (as === 'child' && plant.status !== 'published') throw failure(404, 'PLANT_NOT_FOUND', 'Plant not found');
  return { plant: project(plant, as) };
}

async function update(input = {}) {
  const { id, expectedRevision, ...changes } = input;
  const plant = await find(id);
  assertEditable(plant);
  const fields = plantInput(changes);
  if (!Object.keys(fields).length) throw failure(400, 'PLANT_EDIT_EMPTY', 'Nothing to change');
  // A published card stays publishable: an edit cannot remove what the children rely on.
  if (plant.status === 'published') assertPublishable({ ...plant, ...fields });
  return { plant: managedPlant(await write(id, expectedRevision, fields)) };
}

/**
 * Adds one display photo: a browser data URL, or bytes a Core caller already
 * holds (for example a conversation attachment). The same photo is kept once.
 */
async function addPhoto(input = {}) {
  let data;
  let mimeType;
  if (input.dataUrl !== undefined) {
    if (typeof input.dataUrl !== 'string' || input.dataUrl.length > content.maxDataUrlLength(MAX_PHOTO_BYTES)) {
      throw failure(413, 'PLANT_PHOTO_TOO_LARGE', 'The photo must be 2 MB or less.');
    }
    const parsed = content.parseDataUrl(input.dataUrl);
    if (!parsed?.canonical) throw failure(400, 'PLANT_PHOTO_INVALID', 'Invalid photo.');
    ({ data, mimeType } = parsed);
  } else {
    data = Buffer.isBuffer(input.bytes) ? input.bytes : null;
    mimeType = input.mimeType;
  }
  if (!data?.length || !PHOTO_TYPES.includes(mimeType)) throw failure(400, 'PLANT_PHOTO_INVALID', 'Accepted photos: JPEG or PNG.');
  if (data.length > MAX_PHOTO_BYTES) throw failure(413, 'PLANT_PHOTO_TOO_LARGE', 'The photo must be 2 MB or less.');
  if (!content.imageSignatureMatches(mimeType, data)) throw failure(400, 'PLANT_PHOTO_INVALID', 'The content does not match the image format.');
  const plant = await find(input.id);
  assertEditable(plant);
  const sha256 = content.sha256(data);
  const existing = (plant.photos || []).find(photo => photo.sha256 === sha256);
  if (existing) return { plant: managedPlant(plant), duplicate: true };
  if ((plant.photos || []).length >= LIMITS.photos) throw failure(409, 'PLANT_PHOTO_LIMIT', `A plant keeps at most ${LIMITS.photos} photos.`);
  if (plant.__v !== revision(input.expectedRevision)) throw failure(409, 'PLANT_EDIT_CONFLICT', 'This plant changed. Refresh before editing it.');
  const photo = await PlantPhoto.findOneAndUpdate({ plantId: plant._id, sha256 },
    { $setOnInsert: { plantId: plant._id, sha256, mimeType, size: data.length, data } }, { upsert: true, new: true });
  const saved = await write(input.id, input.expectedRevision, {},
    { $push: { photos: { _id: photo._id, mimeType, size: data.length, sha256 } } });
  return { plant: managedPlant(saved) };
}

async function removePhoto(input = {}) {
  const plant = await find(input.id);
  assertEditable(plant);
  const photoId = String(input.photoId || '');
  if (!(plant.photos || []).some(photo => String(photo._id) === photoId)) throw failure(404, 'PLANT_PHOTO_NOT_FOUND', 'Photo not found');
  const saved = await write(input.id, input.expectedRevision, {}, { $pull: { photos: { _id: new mongoose.Types.ObjectId(photoId) } } });
  await PlantPhoto.deleteOne({ _id: photoId, plantId: plant._id });
  return { plant: managedPlant(saved) };
}

async function photo(input = {}) {
  const plant = await find(input.id);
  if (view(input.view) === 'child' && plant.status !== 'published') throw failure(404, 'PLANT_NOT_FOUND', 'Plant not found');
  const listed = (plant.photos || []).find(entry => String(entry._id) === String(input.photoId || ''));
  const row = listed && await PlantPhoto.findOne({ _id: listed._id, plantId: plant._id }).lean();
  if (!row) throw failure(404, 'PLANT_PHOTO_NOT_FOUND', 'Photo not found');
  return { mimeType: row.mimeType, data: Buffer.from(row.data.buffer || row.data), sha256: row.sha256 };
}

async function publish(input = {}) {
  const plant = await find(input.id);
  assertEditable(plant);
  if (plant.status === 'published') return { plant: managedPlant(plant), alreadyPublished: true };
  assertPublishable(plant);
  return { plant: managedPlant(await write(input.id, input.expectedRevision, { status: 'published', publishedAt: new Date() })) };
}

async function retire(input = {}) {
  const plant = await find(input.id);
  if (plant.status === 'retired') return { plant: managedPlant(plant), alreadyRetired: true };
  return { plant: managedPlant(await write(input.id, input.expectedRevision, { status: 'retired', retiredAt: new Date() })) };
}

module.exports = { MAX_PHOTO_BYTES, addPhoto, create, get, list, photo, publish, removePhoto, retire, update };

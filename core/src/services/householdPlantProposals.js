'use strict';

// Children's plant proposals (#876). A child sends one photo and an optional
// room; Core keeps it as a draft card marked with the child's profile. Nothing
// here publishes, identifies or edits a card: the parent opens the draft (which
// lets identification start), then publishes it through the ordinary card flow
// or declines it with a short reply (householdPlantService.retire).
const mongoose = require('mongoose');
const Plant = require('../../models/HouseholdPlant');
const PlantPhoto = require('../../models/HouseholdPlantPhoto');
const Profile = require('../../models/HouseholdProfile');
const plants = require('./householdPlantService');
const { managedPlant } = require('../domains/household/plants');
const { PROPOSAL_ROOMS, childProposal, isOpen, proposalInput, proposalNickname } = require('../domains/household/plantProposals');

const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const pendingFailure = () => failure(409, 'PLANT_PROPOSAL_PENDING', 'Your plant is already waiting for Dad.');

let indexesReady;
// The one-waiting-proposal rule is a unique index: await it before admitting racing proposals.
function ensureIndexes() {
  if (!indexesReady) indexesReady = Promise.all([Plant.createIndexes(), PlantPhoto.createIndexes()])
    .catch(error => { indexesReady = null; throw error; });
  return indexesReady;
}

async function childProfile(value) {
  const profileId = String(value ?? '').trim();
  const profile = profileId && await Profile.findOne({ profileId, active: true }).lean();
  if (!profile) throw failure(404, 'PLANT_PROPOSAL_PROFILE_UNKNOWN', 'Choose who you are first.');
  return profile;
}

// The child's own proposal; any other card answers as if it did not exist.
async function ownProposal(id, profileId) {
  const plant = await Plant.findById(plants.plantId(id)).lean();
  if (!plant?.proposal || plant.proposal.proposedBy !== profileId) throw failure(404, 'PLANT_PROPOSAL_NOT_FOUND', 'Proposal not found');
  return plant;
}

/**
 * The child's current proposal: the one waiting for a parent, else the latest
 * answer the child has not acknowledged yet. Also the rooms the child can pick.
 */
async function status(input = {}) {
  const profile = await childProfile(input.profileId);
  const plant = await Plant.findOne({ 'proposal.proposedBy': profile.profileId, $or: [
    { 'proposal.open': true },
    { 'proposal.state': { $in: ['accepted', 'declined'] }, 'proposal.seenAt': null }
  ] }).sort({ 'proposal.proposedAt': -1, _id: -1 }).lean();
  return { rooms: PROPOSAL_ROOMS, proposal: plant ? childProposal(plant) : null };
}

/** Sends one photo for a parent to review. One proposal per child waits at a time. */
async function propose(input = {}) {
  const { profileId, room, dataUrl } = proposalInput(input);
  const profile = await childProfile(profileId);
  const photo = plants.displayPhoto({ dataUrl });
  await ensureIndexes();
  if (await Plant.exists({ 'proposal.proposedBy': profile.profileId, 'proposal.open': true })) throw pendingFailure();
  // The photo is stored first under the card's future id, so a card never lists missing bytes.
  const plantId = new mongoose.Types.ObjectId();
  const stored = await PlantPhoto.create({ plantId, sha256: photo.sha256, mimeType: photo.mimeType, size: photo.size, data: photo.data });
  let plant;
  try {
    plant = await Plant.create({
      _id: plantId, nickname: proposalNickname(profile.displayName), room, status: 'draft',
      photos: [{ _id: stored._id, mimeType: photo.mimeType, size: photo.size, sha256: photo.sha256 }],
      proposal: { proposedBy: profile.profileId, open: true, state: 'pending', proposedAt: new Date() }
    });
  } catch (error) {
    await PlantPhoto.deleteOne({ _id: stored._id }).catch(() => {});
    if (error.code === 11000) throw pendingFailure();
    throw error;
  }
  return { proposal: childProposal(plant.toObject()) };
}

/** The child hides an answer once read; a waiting proposal stays on screen. */
async function seen(input = {}) {
  const profile = await childProfile(input.profileId);
  const plant = await ownProposal(input.id, profile.profileId);
  if (isOpen(plant.proposal)) throw failure(409, 'PLANT_PROPOSAL_WAITING', 'Dad has not answered yet.');
  // Not a card edit: the revision the parent holds stays valid.
  await Plant.updateOne({ _id: plant._id, 'proposal.seenAt': null }, { $set: { 'proposal.seenAt': new Date() } });
  return status({ profileId: profile.profileId });
}

/** The child's own photo, while the proposal waits or after the answer. */
async function photo(input = {}) {
  const profile = await childProfile(input.profileId);
  const plant = await ownProposal(input.id, profile.profileId);
  const first = plant.photos?.[0];
  if (!first) throw failure(404, 'PLANT_PHOTO_NOT_FOUND', 'Photo not found');
  return plants.photo({ id: String(plant._id), photoId: String(first._id), view: 'manage' });
}

/**
 * A parent opens a proposal. The first opening is recorded once, even when two
 * pages open it together, and tells the caller to start identification.
 */
async function open(input = {}) {
  const id = plants.plantId(input.id);
  const opened = await Plant.findOneAndUpdate({ _id: id, status: 'draft', 'proposal.state': 'pending' },
    { $set: { 'proposal.state': 'opened', 'proposal.openedAt': new Date() }, $inc: { __v: 1 } }, { new: true }).lean();
  if (opened) return { plant: managedPlant(opened), opened: true };
  const plant = await Plant.findById(id).lean();
  if (!plant) throw failure(404, 'PLANT_NOT_FOUND', 'Plant not found');
  if (!plant.proposal) throw failure(409, 'PLANT_NOT_PROPOSAL', 'This plant is not a child\'s proposal.');
  return { plant: managedPlant(plant), opened: false };
}

/** A parent declines an open proposal; the child reads the reply. */
async function decline(input = {}) {
  const id = plants.plantId(input.id);
  const plant = await Plant.findById(id).lean();
  if (!plant) throw failure(404, 'PLANT_NOT_FOUND', 'Plant not found');
  if (!isOpen(plant.proposal)) throw failure(409, 'PLANT_PROPOSAL_CLOSED', 'This proposal was already answered.');
  return plants.retire({ id, expectedRevision: input.expectedRevision, reply: input.reply });
}

module.exports = { decline, ensureIndexes, open, photo, propose, seen, status };

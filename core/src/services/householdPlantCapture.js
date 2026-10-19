'use strict';

// Nestor starts a plant card from the photo Dad just sent him (#867). The
// conversation's model never sees attachment ids, so the card takes the latest
// image of the owner's personal Nestor conversations from the last half hour.
// It only creates a draft and starts identification; the parent reviews it.

const Attachment = require('../../models/ConversationAttachment');
const Conversation = require('../../models/Conversation');
const Plant = require('../../models/HouseholdPlant');
const plants = require('./householdPlantService');

const RECENT_MS = 30 * 60 * 1000;
const PHOTO_TYPES = ['image/jpeg', 'image/png'];
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const reviewUrl = id => `/dad/family/plants?plant=${encodeURIComponent(id)}`;

async function latestPersonalPhoto(now = new Date()) {
  const rows = await Attachment.find({ kind: 'image', mimeType: { $in: PHOTO_TYPES },
    createdAt: { $gte: new Date(now.getTime() - RECENT_MS) } }).sort({ createdAt: -1 }).limit(10).lean();
  for (const row of rows) {
    const owner = await Conversation.exists({ _id: row.conversationId, surface: 'household',
      'surfaceSession.packId': 'personal_operator', 'surfaceSession.scopeId': 'personal',
      'surfaceSession.deletedAt': { $exists: false } });
    if (owner) return row;
  }
  return null;
}

function createPlantCapture({ assistant, now = () => new Date() } = {}) {
  async function draftFromLatestPhoto(input = {}) {
    const photo = await latestPersonalPhoto(now());
    if (!photo) throw failure(404, 'PLANT_PHOTO_NOT_FOUND', 'No plant photo in the personal conversation from the last 30 minutes. Ask Dad to attach it.');
    const data = Buffer.from(photo.data.buffer || photo.data);
    const existing = await Plant.findOne({ 'photos.sha256': photo.sha256, status: { $ne: 'retired' } }).select('_id nickname status').lean();
    if (existing) {
      return { plant: { id: String(existing._id), nickname: existing.nickname, status: existing.status }, duplicate: true,
        review: 'parent', reviewUrl: reviewUrl(String(existing._id)) };
    }
    const { plant } = await plants.create({ nickname: input.nickname || 'Nouvelle plante',
      ...(input.room ? { room: input.room } : {}), ...(input.spot ? { spot: input.spot } : {}) });
    await plants.addPhoto({ id: plant.id, expectedRevision: plant.revision, bytes: data, mimeType: photo.mimeType });
    let identification = 'running';
    try { await assistant.identify({ id: plant.id }); }
    catch (error) { identification = `not started: ${error.code || error.message}`; }
    return { plant: { id: plant.id, nickname: plant.nickname, status: 'draft' }, identification, review: 'parent',
      reviewUrl: reviewUrl(plant.id) };
  }
  return Object.freeze({ draftFromLatestPhoto });
}

module.exports = { createPlantCapture, latestPersonalPhoto };

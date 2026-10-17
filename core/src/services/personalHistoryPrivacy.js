'use strict';

const { createHash } = require('node:crypto');
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');

const erased = () => ({ text: '', actor: '', sourceStatus: '', eventDate: '', eventDateAsWritten: '',
  eventDatePrecision: 'unknown', reviewState: 'forgotten', reviewHistory: [], forgottenAt: new Date(),
  decision: { reason: '', at: new Date() } });

async function suppress(filter) {
  return Entry.updateMany({ scope: 'owner', ...filter, reviewState: { $ne: 'forgotten' } },
    { $set: erased(), $inc: { revision: 1 } });
}

async function forgetSourceNote(note) {
  const noteId = String(note._id || note.id);
  const contentHash = note.text ? createHash('sha256').update(note.text.toLowerCase()).digest('hex') : note.contentHash || '';
  try {
    await Suppression.updateOne({ noteId }, { $setOnInsert: {
      noteId, contentHash, scope: 'owner', forgottenAt: note.forgottenAt || new Date()
    } }, { upsert: true, runValidators: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    if (!await Suppression.exists({ noteId })) throw error;
  }
  const matches = [{ 'source.personalNoteId': noteId }, { souvenirNoteId: noteId }];
  if (contentHash) matches.push({ contentHash });
  return suppress({ $or: matches });
}

async function forgottenSource({ noteId, contentHash }) {
  const matches = [];
  if (noteId) matches.push({ noteId });
  if (contentHash) matches.push({ contentHash });
  if (!matches.length) return false;
  if (await Suppression.exists({ scope: 'owner', $or: matches })) return true;
  const legacy = [];
  if (noteId) legacy.push({ _id: noteId });
  if (contentHash) legacy.push({ contentHash });
  const note = await MemoryNote.findOne({ status: 'forgotten', $or: legacy }).lean();
  if (!note) return false;
  await forgetSourceNote(note);
  return true;
}

module.exports = { suppress, forgetSourceNote, forgottenSource };

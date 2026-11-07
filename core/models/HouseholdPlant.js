'use strict';

const mongoose = require('mongoose');

// A household plant card (#866). Field rules live in the household domain
// (src/domains/household/plants.js); photo bytes live in household_plant_photos.
const sourced = { text: String, sources: [String] };
const toxicitySubject = { level: { type: String, enum: ['unknown', 'none', 'mild', 'toxic'], default: 'unknown' }, note: String, sources: [String] };
const species = { commonName: String, latinName: String, confidence: Number, traits: String };

const schema = new mongoose.Schema({
  nickname: { type: String, required: true, maxlength: 60, trim: true },
  room: { type: String, maxlength: 60, default: null },
  spot: { type: String, maxlength: 120, default: null },
  status: { type: String, enum: ['draft', 'published', 'retired'], default: 'draft', index: true },
  identification: {
    type: new mongoose.Schema({ ...species, source: { type: String, enum: ['parent', 'model'] }, model: String,
      candidates: [new mongoose.Schema(species, { _id: false })] }, { _id: false }),
    default: null
  },
  careSheet: {
    type: new mongoose.Schema(Object.fromEntries(['light', 'water', 'humidity', 'soil', 'repotting', 'fertilizer', 'mistakes']
      .map(key => [key, { type: new mongoose.Schema(sourced, { _id: false }), default: undefined }])), { _id: false }),
    default: () => ({})
  },
  toxicity: {
    type: new mongoose.Schema({ children: toxicitySubject, cats: toxicitySubject, dogs: toxicitySubject,
      reviewed: { type: Boolean, default: false } }, { _id: false }),
    default: null
  },
  funFact: { type: String, maxlength: 300, default: null },
  carePlan: [new mongoose.Schema({
    key: String, title: String, note: String,
    cadence: { type: String, enum: ['once', 'daily', 'weekly', 'interval'] },
    intervalDays: Number, winterIntervalDays: Number, stars: Number,
    minAgeBand: { type: String, enum: ['little', 'school', 'teen'] }, profileId: String
  }, { _id: false })],
  photos: [new mongoose.Schema({
    _id: { type: mongoose.Schema.Types.ObjectId, required: true },
    mimeType: String, size: Number, sha256: String
  }, { _id: false })],
  // Model help (#867): its proposals wait here until the parent applies them.
  assistant: {
    identify: { queueId: String, state: { type: String, enum: ['queued', 'running', 'completed', 'failed'] }, error: String, model: String,
      startedAt: Date, finishedAt: Date, candidates: [new mongoose.Schema(species, { _id: false })] },
    care: { state: { type: String, enum: ['running', 'completed', 'failed'] }, error: String, model: String,
      startedAt: Date, finishedAt: Date, unsourced: Boolean, draft: mongoose.Schema.Types.Mixed }
  },
  // A child's proposal (#876; rules in src/domains/household/plantProposals.js).
  // `open` is true only while the proposal waits for a parent; the partial
  // unique index below keeps one waiting proposal per child.
  proposal: {
    type: new mongoose.Schema({
      proposedBy: { type: String, required: true },
      open: { type: Boolean },
      state: { type: String, enum: ['pending', 'opened', 'accepted', 'declined'], required: true },
      proposedAt: Date, openedAt: Date, decidedAt: Date,
      reply: { type: String, maxlength: 160 },
      seenAt: Date
    }, { _id: false }),
    default: null
  },
  publishedAt: { type: Date, default: null },
  retiredAt: { type: Date, default: null }
}, { timestamps: true, collection: 'household_plants' });
schema.index({ 'proposal.proposedBy': 1 }, { name: 'one_open_proposal_per_child', unique: true,
  partialFilterExpression: { 'proposal.open': true } });

module.exports = mongoose.models.HouseholdPlant || mongoose.model('HouseholdPlant', schema);

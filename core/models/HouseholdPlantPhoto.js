'use strict';

const mongoose = require('mongoose');

// The display rendition of a plant photo (#866): a JPEG or PNG of 2 MB or less,
// kept with the household data so cards render without the optional image archive.
const schema = new mongoose.Schema({
  plantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  mimeType: { type: String, enum: ['image/jpeg', 'image/png'], required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  data: { type: Buffer, required: true },
  createdAt: { type: Date, default: Date.now }
}, { collection: 'household_plant_photos' });
schema.index({ plantId: 1, sha256: 1 }, { unique: true });

module.exports = mongoose.models.HouseholdPlantPhoto || mongoose.model('HouseholdPlantPhoto', schema);

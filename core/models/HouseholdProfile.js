'use strict';

const mongoose = require('mongoose');
const { AGE_BANDS } = require('../src/domains/household/family');

const HouseholdProfileSchema = new mongoose.Schema({
  profileId: { type: String, required: true, unique: true, index: true },
  displayName: { type: String, required: true },
  ageBand: { type: String, enum: AGE_BANDS, default: 'school' },
  avatar: { type: String, default: '⭐' },
  // Optional YYYY-MM-DD, set by the parent; never part of the public profile projection.
  birthDate: { type: String },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: String, default: 'household-parent' }
}, { timestamps: true, collection: 'household_profiles' });

module.exports = mongoose.model('HouseholdProfile', HouseholdProfileSchema);

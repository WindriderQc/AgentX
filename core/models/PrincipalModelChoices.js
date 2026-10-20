'use strict';

const mongoose = require('mongoose');

// The two models the principal switch offers (Standard, Abliterated), named
// by the operator in the Nerve Center. One document; a null model is unset.
const PrincipalModelChoicesSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'principal' },
  standard: { type: String, default: null, trim: true, maxlength: 512 },
  abliterated: { type: String, default: null, trim: true, maxlength: 512 },
  revision: { type: Number, required: true, default: 0, min: 0 },
  // 'migrated': seeded once from what the install ran; 'operator': saved in the UI.
  source: { type: String, required: true, enum: ['migrated', 'operator'] },
  updatedBy: { type: String, default: null, maxlength: 200 }
}, { collection: 'principal_model_choices', timestamps: true });

module.exports = mongoose.models.PrincipalModelChoices
  || mongoose.model('PrincipalModelChoices', PrincipalModelChoicesSchema);

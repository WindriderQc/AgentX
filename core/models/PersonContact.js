'use strict';

const mongoose = require('mongoose');

// The owner's registry of people met in mail and contact cards. Every field
// except the decision state is derived from the person's observations, so a
// merge and its undo only move observations between people.
const schema = new mongoose.Schema({
  scope: { type: String, enum: ['owner'], default: 'owner', required: true },
  state: { type: String, enum: ['active', 'merged'], default: 'active' },
  mergedInto: { type: String, default: '', maxlength: 24 },
  displayName: { type: String, default: '', maxlength: 300 },
  names: [{ type: String, maxlength: 300 }],
  foldedNames: [{ type: String, maxlength: 300 }],
  emails: [{ type: String, maxlength: 320 }],
  phones: [{ type: String, maxlength: 40 }],
  organizations: [{ type: String, maxlength: 300 }],
  exchanges: { type: Number, default: 0 },
  firstSeen: { type: Date, default: null },
  lastSeen: { type: Date, default: null },
  revision: { type: Number, default: 0 }
}, { timestamps: true, collection: 'person_contacts' });

schema.index({ scope: 1, state: 1, exchanges: -1, _id: 1 });
schema.index({ scope: 1, emails: 1 });
schema.index({ scope: 1, phones: 1 });
schema.index({ scope: 1, foldedNames: 1 });

module.exports = mongoose.models.PersonContact || mongoose.model('PersonContact', schema);

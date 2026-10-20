'use strict';

const mongoose = require('mongoose');

// One sighting of a person in a preserved source: a mail header or a contact
// card. The key makes an import replayable; personId moves on merge and undo.
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, maxlength: 64 },
  scope: { type: String, enum: ['owner'], default: 'owner', required: true },
  personId: { type: String, required: true, maxlength: 24, index: true },
  source: { type: String, enum: ['gmail-header', 'gmail-vcf', 'outlook-vcf'], required: true },
  role: { type: String, enum: ['from', 'to', 'cc', 'vcard'], required: true },
  name: { type: String, default: '', maxlength: 300 },
  email: { type: String, default: '', maxlength: 320 },
  phones: [{ type: String, maxlength: 40 }],
  organization: { type: String, default: '', maxlength: 300 },
  note: { type: String, default: '', maxlength: 2000 },
  occurredAt: { type: Date, default: null },
  direction: { type: String, enum: ['received', 'sent', 'draft', 'unknown'], default: 'unknown' },
  ref: {
    threadId: { type: String, default: '', maxlength: 256 },
    messageId: { type: String, default: '', maxlength: 256 },
    sourceSha256: { type: String, default: '', maxlength: 64 },
    assertionId: { type: String, default: '', maxlength: 64 }
  }
}, { timestamps: true, collection: 'person_observations' });

schema.index({ scope: 1, personId: 1, occurredAt: -1 });

module.exports = mongoose.models.PersonObservation || mongoose.model('PersonObservation', schema);

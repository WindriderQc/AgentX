'use strict';

const mongoose = require('mongoose');
const hash = { type: String, match: /^[a-f0-9]{64}$/, default: null };

// Native _id uniqueness reserves one request before any native verification.
// Only opaque hashes survive here: no source references, snapshots or reasons.
const schema = new mongoose.Schema({
  _id: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  inputSha256: { ...hash, required: true },
  state: { type: String, enum: ['preparing', 'prepared', 'confirming', 'confirmed', 'blocked'], required: true },
  bindingSha256: hash,
  manifestSha256: hash,
  coreRestorationSha256: hash,
  preparedAt: { type: Date, default: null },
  confirmedAt: { type: Date, default: null },
  blockedCode: { type: String, enum: ['evidence_changed', 'evidence_unavailable', 'evidence_capacity', null], default: null }
}, { timestamps: true, collection: 'personal_history_manifest_confirmations', strict: 'throw' });

module.exports = mongoose.models.PersonalHistoryManifestConfirmation
  || mongoose.model('PersonalHistoryManifestConfirmation', schema);

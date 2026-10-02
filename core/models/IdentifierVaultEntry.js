'use strict';

const mongoose = require('mongoose');

// One sensitive identifier of the owner (government id, account or card
// number), encrypted with the instance key. Notes and journal entries keep
// only a "[coffre: label]" reference to it.
const schema = new mongoose.Schema({
  label: { type: String, required: true },
  kind: { type: String, required: true },
  sealed: { type: String, required: true },
  fingerprint: { type: String, required: true, unique: true },
  last4: { type: String, default: '' },
  seenIn: { type: [String], default: [] }
}, { timestamps: true, collection: 'identifier_vault' });

module.exports = mongoose.models.IdentifierVaultEntry || mongoose.model('IdentifierVaultEntry', schema);

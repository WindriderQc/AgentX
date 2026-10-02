'use strict';

const mongoose = require('mongoose');

// The parental code set from the AgentX host when AGENTX_PARENTAL_CODE is not
// configured. Only a scrypt hash and its salt are kept, never the code itself.
// numericLength lets the unlock form submit on its last digit, as with the
// configured code.
const ParentalCodeSchema = new mongoose.Schema({
  subject: { type: String, required: true, unique: true },
  salt: { type: String, required: true },
  hash: { type: String, required: true },
  N: { type: Number, required: true },
  r: { type: Number, required: true },
  p: { type: Number, required: true },
  numericLength: { type: Number, default: null }
}, { timestamps: true, collection: 'access_parental_code' });

module.exports = mongoose.model('ParentalCode', ParentalCodeSchema);

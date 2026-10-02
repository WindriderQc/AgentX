'use strict';
const { Schema } = require('mongoose');
module.exports = new Schema({
  id: { type: String, required: true }, name: { type: String, required: true },
  mimeType: { type: String, required: true }, size: { type: Number, required: true },
  kind: { type: String, enum: ['image', 'document'], required: true }
}, { _id: false });

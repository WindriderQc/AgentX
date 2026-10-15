'use strict';
const { Schema } = require('mongoose');
const contract = require('../../shared/answerBlocks');
const table = new Schema({ kind: { type: String, enum: ['table'], required: true },
  title: { type: String, required: true }, columns: [String], rows: [[String]] }, { _id: false, strict: 'throw' });
const envelope = new Schema({ schema: { type: String, enum: [contract.SCHEMA], required: true },
  blocks: { type: [table], required: true } }, { _id: false, strict: 'throw' });

module.exports = {
  type: envelope, default: undefined,
  // Validate before Mongoose coerces cells or strips unknown keys.
  set: value => value === undefined ? undefined : contract.normalizeEnvelope(value?.toObject ? value.toObject() : value),
  validate: {
    validator(value) { return value === undefined || this.role === 'assistant'
      && contract.isCompleteFallback(this.content, value.toObject()); },
    message: 'Assistant answer blocks require their complete canonical text fallback.'
  }
};

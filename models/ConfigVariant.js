/**
 * ConfigVariant Model
 * Stores predefined configuration presets for benchmarking config variation workflows.
 */

const mongoose = require('mongoose');

const ConfigVariantSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    default: '',
    maxlength: 500
  },
  use_cases: {
    type: [String],
    default: []
  },
  parameters: {
    temperature: {
      type: Number,
      default: null
    },
    top_p: {
      type: Number,
      default: null
    },
    top_k: {
      type: Number,
      default: null
    },
    repeat_penalty: {
      type: Number,
      default: null
    },
    num_ctx: {
      type: Number,
      default: null
    },
    num_predict: {
      type: Number,
      default: null
    }
  },
  tags: {
    type: [String],
    default: []
  },
  expected_characteristics: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  isSystem: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true
});

ConfigVariantSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('ConfigVariant', ConfigVariantSchema);

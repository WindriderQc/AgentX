const mongoose = require('mongoose');

const PromptConfigSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  systemPrompt: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: false
  },
  version: {
    type: Number,
    default: 1
  },
  description: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

PromptConfigSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Create compound index for name + version to allow versioning
PromptConfigSchema.index({ name: 1, version: 1 }, { unique: true });

// Static method to get active prompt by name
PromptConfigSchema.statics.getActive = async function(name = 'default_chat') {
  return this.findOne({ name, isActive: true }).sort({ version: -1 });
};

module.exports = mongoose.model('PromptConfig', PromptConfigSchema);

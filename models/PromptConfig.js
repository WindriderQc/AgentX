const mongoose = require('mongoose');

/**
 * PromptConfig Model - V4 Analytics & Improvement
 * 
 * Tracks system prompt versions for A/B testing and improvement loops.
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 1
 */

const PromptConfigSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true,
    trim: true
  }, // e.g., "default_chat"
  
  version: { 
    type: Number, 
    required: true,
    min: 1
  }, // Incremental integer (1, 2, 3...)
  
  systemPrompt: { 
    type: String, 
    required: true 
  },
  
  description: { 
    type: String,
    default: ''
  }, // Reason for this version (e.g. "Added fix for coding style")
  
  status: {
    type: String,
    enum: ['active', 'deprecated', 'proposed'],
    default: 'proposed',
    required: true
  },
  
  author: { 
    type: String, 
    default: 'system' 
  }, // 'system', 'human', or 'n8n'
  
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Composite index to ensure version uniqueness per prompt name
PromptConfigSchema.index({ name: 1, version: 1 }, { unique: true });

// Index for querying active prompts efficiently
PromptConfigSchema.index({ name: 1, status: 1 });

// Update timestamp on save
PromptConfigSchema.pre('save', function() {
  this.updatedAt = Date.now();
});

/**
 * Static method to get the active prompt for a given name
 * @param {string} name - Prompt name (e.g., "default_chat")
 * @returns {Promise<PromptConfig|null>}
 */
PromptConfigSchema.statics.getActive = async function(name) {
  return this.findOne({ name, status: 'active' }).sort({ version: -1 });
};

/**
 * Static method to activate a prompt (and deactivate others with same name)
 * @param {string} promptConfigId - ID of prompt to activate
 * @returns {Promise<PromptConfig>}
 */
PromptConfigSchema.statics.activate = async function(promptConfigId) {
  const prompt = await this.findById(promptConfigId);
  if (!prompt) {
    throw new Error('PromptConfig not found');
  }
  
  // Deactivate all other prompts with the same name
  await this.updateMany(
    { name: prompt.name, status: 'active' },
    { $set: { status: 'deprecated', updatedAt: new Date() } }
  );
  
  // Activate this one
  prompt.status = 'active';
  await prompt.save();
  
  console.log(`[PromptConfig] Activated ${prompt.name} v${prompt.version}`);
  return prompt;
};

module.exports = mongoose.model('PromptConfig', PromptConfigSchema);

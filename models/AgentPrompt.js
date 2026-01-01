const mongoose = require('mongoose');

const agentPromptSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  template: { type: String, required: true },
  variables: [String],  // Simple array: ['user', 'task', 'context']
  tags: [String]
}, { timestamps: true });

module.exports = mongoose.model('AgentPrompt', agentPromptSchema);

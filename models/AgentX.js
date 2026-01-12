const mongoose = require('mongoose');

/**
 * N8N Tool Schema - Defines an N8N workflow as a callable LLM tool
 */
const N8nToolSchema = new mongoose.Schema({
  toolId: {
    type: String,
    required: true,
    trim: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  webhookUrl: {
    type: String,
    required: true,
    trim: true
  },
  // JSON Schema for tool parameters (OpenAI function calling format)
  inputSchema: {
    type: mongoose.Schema.Types.Mixed,
    default: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  // Timeout in milliseconds for webhook call
  timeout: {
    type: Number,
    default: 30000
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: true });

/**
 * AgentX Schema - Unified Agent combining Model + Prompt + Tools
 *
 * References PromptConfig to preserve A/B testing and versioning.
 * N8N workflows are defined as LLM tools for proper tool-calling flow.
 */
const AgentXSchema = new mongoose.Schema({
  // Identity
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  avatar: {
    type: String,
    default: 'fa-robot'  // FontAwesome icon class
  },

  // Category for filtering/organization
  category: {
    type: String,
    enum: ['coding', 'reasoning', 'factual', 'math', 'creative', 'general', 'specialist'],
    default: 'general',
    index: true
  },
  tags: [{
    type: String,
    trim: true
  }],

  // Prompt Configuration (reference to preserve A/B testing)
  promptConfigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PromptConfig',
    required: true
  },

  // Model Configuration
  defaultModel: {
    type: String,
    required: true
  },
  fallbackModels: [{
    type: String
  }],
  modelConstraints: {
    temperature: {
      type: Number,
      default: 0.7,
      min: 0,
      max: 2
    },
    maxTokens: {
      type: Number,
      default: 2048
    },
    topP: {
      type: Number,
      default: 0.9,
      min: 0,
      max: 1
    },
    topK: {
      type: Number,
      default: 40
    }
  },

  // N8N Workflows as LLM Tools
  n8nTools: [N8nToolSchema],

  // Capabilities
  capabilities: {
    supportsRag: {
      type: Boolean,
      default: true
    },
    supportsStreaming: {
      type: Boolean,
      default: true
    },
    supportsVision: {
      type: Boolean,
      default: false
    },
    autoRoute: {
      type: Boolean,
      default: false
    }
  },

  // Multi-tenancy
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: false,
    index: true
  },

  // Status
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  isDefault: {
    type: Boolean,
    default: false
  },

  // Creator tracking
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile'
  },

  // Usage Statistics
  stats: {
    totalConversations: {
      type: Number,
      default: 0
    },
    totalMessages: {
      type: Number,
      default: 0
    },
    toolInvocations: {
      type: Number,
      default: 0
    },
    avgResponseTime: {
      type: Number,
      default: 0
    },
    positiveRatings: {
      type: Number,
      default: 0
    },
    negativeRatings: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

// Compound indexes
AgentXSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
AgentXSchema.index({ workspaceId: 1, category: 1, isActive: 1 });
AgentXSchema.index({ workspaceId: 1, isDefault: 1 });

/**
 * Get all active agents for a workspace (with fallback to global)
 */
AgentXSchema.statics.getActive = async function(workspaceId = null) {
  const query = { isActive: true };

  if (workspaceId) {
    // Get workspace-specific agents, or global agents if none exist
    query.$or = [
      { workspaceId: workspaceId },
      { workspaceId: { $exists: false } },
      { workspaceId: null }
    ];
  }

  return this.find(query)
    .populate('promptConfigId', 'name systemPrompt version isActive description')
    .sort({ displayName: 1 });
};

/**
 * Get the default agent for a workspace
 */
AgentXSchema.statics.getDefault = async function(workspaceId = null) {
  const query = { isDefault: true, isActive: true };

  if (workspaceId) {
    query.workspaceId = workspaceId;
  }

  let agent = await this.findOne(query)
    .populate('promptConfigId', 'name systemPrompt version isActive description');

  // Fallback to first active agent if no default set
  if (!agent) {
    const activeQuery = { isActive: true };
    if (workspaceId) {
      activeQuery.workspaceId = workspaceId;
    }
    agent = await this.findOne(activeQuery)
      .populate('promptConfigId', 'name systemPrompt version isActive description')
      .sort({ createdAt: 1 });
  }

  return agent;
};

/**
 * Get agents by category
 */
AgentXSchema.statics.findByCategory = async function(category, workspaceId = null) {
  const query = { category, isActive: true };

  if (workspaceId) {
    query.$or = [
      { workspaceId: workspaceId },
      { workspaceId: { $exists: false } },
      { workspaceId: null }
    ];
  }

  return this.find(query)
    .populate('promptConfigId', 'name systemPrompt version isActive description')
    .sort({ displayName: 1 });
};

/**
 * Get fully hydrated agent by ID (with all references populated)
 */
AgentXSchema.statics.getFullAgent = async function(agentId) {
  return this.findById(agentId)
    .populate('promptConfigId')
    .populate('workspaceId', 'name')
    .populate('createdBy', 'displayName email');
};

/**
 * Set an agent as the default for its workspace
 */
AgentXSchema.statics.setDefault = async function(agentId) {
  const agent = await this.findById(agentId);
  if (!agent) {
    const err = new Error('Agent not found');
    err.status = 404;
    throw err;
  }

  // Unset any existing default in the same workspace
  await this.updateMany(
    {
      workspaceId: agent.workspaceId,
      isDefault: true,
      _id: { $ne: agent._id }
    },
    { $set: { isDefault: false } }
  );

  // Set this agent as default
  agent.isDefault = true;
  await agent.save();

  return agent;
};

/**
 * Convert N8N tools to Ollama tool format
 */
AgentXSchema.methods.getToolDefinitions = function() {
  return this.n8nTools
    .filter(tool => tool.isActive)
    .map(tool => ({
      type: 'function',
      function: {
        name: `n8n_${tool.toolId}`,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
};

/**
 * Find a specific N8N tool by ID
 */
AgentXSchema.methods.findTool = function(toolId) {
  // Handle both 'n8n_toolId' and 'toolId' formats
  const cleanId = toolId.replace(/^n8n_/, '');
  return this.n8nTools.find(t => t.toolId === cleanId);
};

/**
 * Record a tool invocation
 */
AgentXSchema.methods.recordToolInvocation = async function() {
  this.stats.toolInvocations = (this.stats.toolInvocations || 0) + 1;
  await this.save();
};

/**
 * Record a conversation
 */
AgentXSchema.methods.recordConversation = async function() {
  this.stats.totalConversations = (this.stats.totalConversations || 0) + 1;
  await this.save();
};

/**
 * Record feedback
 */
AgentXSchema.methods.recordFeedback = async function(isPositive) {
  if (isPositive) {
    this.stats.positiveRatings = (this.stats.positiveRatings || 0) + 1;
  } else {
    this.stats.negativeRatings = (this.stats.negativeRatings || 0) + 1;
  }
  await this.save();
};

module.exports = mongoose.model('AgentX', AgentXSchema);

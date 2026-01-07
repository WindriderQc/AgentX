const mongoose = require('mongoose');

/**
 * N8nLLMSource Model
 *
 * Stores configuration for n8n webhook-based LLM providers.
 * Allows users to register cloud LLMs (OpenAI, Anthropic, Google) accessible via n8n workflows.
 *
 * Use case: User has OpenAI API key in n8n, creates webhook that calls GPT-4,
 *           registers webhook here, then can select "GPT-4 via n8n" in AgentX chat.
 */

const N8nLLMSourceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },

  provider: {
    type: String,
    required: true,
    enum: ['openai', 'anthropic', 'google', 'cohere', 'custom'],
    index: true
  },

  webhookUrl: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: function(url) {
        return /^https?:\/\/.+/.test(url);
      },
      message: 'Invalid webhook URL format'
    }
  },

  authentication: {
    type: {
      type: String,
      enum: ['none', 'api-key', 'bearer', 'basic'],
      default: 'none'
    },
    keyName: String,           // Header name (e.g., 'x-api-key', 'Authorization')
    encryptedKey: String       // Encrypted API key if needed (future: use crypto)
  },

  capabilities: {
    maxContext: {
      type: Number,
      default: 4096,
      min: 512,
      max: 200000
    },
    supportsStreaming: {
      type: Boolean,
      default: false
    },
    supportsThinking: {
      type: Boolean,
      default: false
    },
    estimatedLatencyMs: {
      type: Number,
      default: 1000,
      min: 0
    }
  },

  requestFormat: {
    method: {
      type: String,
      enum: ['POST', 'GET'],
      default: 'POST'
    },
    bodyTemplate: {
      type: String,
      required: true,
      default: '{"prompt": "{{prompt}}", "max_tokens": {{maxTokens}}}'
    },
    headers: {
      type: Map,
      of: String,
      default: () => new Map([['Content-Type', 'application/json']])
    },
    responseExtractor: {
      type: String,
      required: true,
      default: 'completion',
      // JSON path to extract response (e.g., 'data.completion', 'choices[0].message.content')
    }
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile',
    required: true
  },

  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  lastUsed: {
    type: Date
  },

  usageCount: {
    type: Number,
    default: 0,
    min: 0
  },

  lastTestResult: {
    success: Boolean,
    latencyMs: Number,
    error: String,
    testedAt: Date
  },

  metadata: {
    description: String,
    tags: [String],
    version: {
      type: String,
      default: '1.0'
    }
  }
});

// Indexes for common queries
N8nLLMSourceSchema.index({ isActive: 1, createdAt: -1 });
N8nLLMSourceSchema.index({ provider: 1, isActive: 1 });
N8nLLMSourceSchema.index({ createdBy: 1, isActive: 1 });

// Virtual for display name with provider
N8nLLMSourceSchema.virtual('displayName').get(function() {
  return `${this.name} (${this.provider})`;
});

// Static method: Get all active sources
N8nLLMSourceSchema.statics.getActiveSources = async function(provider = null) {
  const query = { isActive: true };
  if (provider) {
    query.provider = provider;
  }
  return this.find(query).sort({ createdAt: -1 });
};

// Static method: Get sources for specific user
N8nLLMSourceSchema.statics.getUserSources = async function(userId, activeOnly = true) {
  const query = { createdBy: userId };
  if (activeOnly) {
    query.isActive = true;
  }
  return this.find(query).sort({ lastUsed: -1, createdAt: -1 });
};

// Instance method: Test webhook connection
N8nLLMSourceSchema.methods.testConnection = async function(testPrompt = 'Test') {
  const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

  try {
    const startTime = Date.now();

    // Replace template variables
    const body = this.requestFormat.bodyTemplate
      .replace(/\{\{prompt\}\}/g, testPrompt)
      .replace(/\{\{maxTokens\}\}/g, '50')
      .replace(/\{\{temperature\}\}/g, '0.7');

    const options = {
      method: this.requestFormat.method,
      headers: Object.fromEntries(this.requestFormat.headers),
      timeout: 10000
    };

    if (this.requestFormat.method === 'POST') {
      options.body = body;
    }

    // Add authentication if configured
    if (this.authentication.type !== 'none' && this.authentication.keyName && this.authentication.encryptedKey) {
      options.headers[this.authentication.keyName] = this.authentication.encryptedKey;
    }

    const response = await fetch(this.webhookUrl, options);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Extract response using responseExtractor path
    const extracted = this._extractResponse(data, this.requestFormat.responseExtractor);

    if (!extracted) {
      throw new Error(`Could not extract response using path: ${this.requestFormat.responseExtractor}`);
    }

    // Update test result
    this.lastTestResult = {
      success: true,
      latencyMs,
      testedAt: new Date()
    };

    await this.save();

    return {
      success: true,
      latencyMs,
      response: extracted,
      timestamp: new Date()
    };

  } catch (error) {
    // Update test result with error
    this.lastTestResult = {
      success: false,
      error: error.message,
      testedAt: new Date()
    };

    await this.save();

    return {
      success: false,
      error: error.message,
      timestamp: new Date()
    };
  }
};

// Instance method: Record usage
N8nLLMSourceSchema.methods.recordUsage = async function() {
  this.usageCount += 1;
  this.lastUsed = new Date();
  await this.save();
};

// Helper: Extract response from nested object using JSON path
N8nLLMSourceSchema.methods._extractResponse = function(data, path) {
  if (!path) return data;

  const parts = path.split('.');
  let current = data;

  for (const part of parts) {
    // Handle array notation: choices[0]
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      current = current?.[key]?.[parseInt(index)];
    } else {
      current = current?.[part];
    }

    if (current === undefined) return null;
  }

  return current;
};

// Pre-save hook: Validate webhook URL is reachable (optional, can be slow)
// N8nLLMSourceSchema.pre('save', async function(next) {
//   if (this.isModified('webhookUrl')) {
//     // Could add URL validation here
//   }
//   next();
// });

module.exports = mongoose.model('N8nLLMSource', N8nLLMSourceSchema);

const path = require('path');
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const { randomUUID } = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3080;

// Initialize database (async)
let dbReady = false;
db.initDatabase()
  .then(() => {
    dbReady = true;
    console.log('Database ready');
  })
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function resolveTarget(target) {
  const fallback = 'http://localhost:11434';
  if (!target || typeof target !== 'string') return fallback;

  const trimmed = target.trim();
  if (!trimmed) return fallback;

  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `http://${trimmed.replace(/\/+$/, '')}`;
}

function buildErrorResponse(err) {
  return {
    status: 'error',
    message: err.message || 'Unknown error',
    details: err.body || undefined,
  };
}

function sanitizeOptions(options = {}) {
  const numericKeys = [
    'temperature',
    'top_k',
    'top_p',
    'num_ctx',
    'repeat_penalty',
    'presence_penalty',
    'frequency_penalty',
    'seed',
    'num_predict',
    'typical_p',
    'tfs_z',
    'mirostat',
    'mirostat_eta',
    'mirostat_tau',
  ];
  const clean = {};

  numericKeys.forEach((key) => {
    if (options[key] === 0 || options[key]) {
      const parsed = Number(options[key]);
      if (!Number.isNaN(parsed)) {
        clean[key] = parsed;
      }
    }
  });

  if (Array.isArray(options.stop)) {
    clean.stop = options.stop;
  } else if (typeof options.stop === 'string' && options.stop.trim()) {
    clean.stop = options.stop
      .split(',')
      .map((val) => val.trim())
      .filter(Boolean);
  }

  if (options.keep_alive) {
    clean.keep_alive = options.keep_alive;
  }

  return clean;
}

async function proxyOllama(pathSegment, target, init) {
  const url = `${resolveTarget(target)}${pathSegment.startsWith('/') ? '' : '/'}${pathSegment}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error(`Ollama request failed (${response.status})`);
    error.status = response.status;
    error.body = payload;
    throw error;
  }

  return payload;
}

app.get('/api/ollama/models', async (req, res) => {
  const target = req.query.target || 'localhost:11434';
  try {
    const result = await proxyOllama('/api/tags', target, { method: 'GET' });
    const models = Array.isArray(result?.models)
      ? result.models.map((model) => ({
          name: model.name,
          size: model.size,
          modified_at: model.modified_at,
        }))
      : [];
    res.json({ status: 'success', data: models });
  } catch (err) {
    res.status(err.status || 500).json(buildErrorResponse(err));
  }
});

app.post('/api/ollama/chat', async (req, res) => {
  const { target = 'localhost:11434', model, messages = [], system, options = {} } = req.body || {};

  if (!model) {
    return res.status(400).json({ status: 'error', message: 'Model is required' });
  }

  const formattedMessages = [];
  if (system) {
    formattedMessages.push({ role: 'system', content: system });
  }

  if (Array.isArray(messages)) {
    messages.forEach((msg) => {
      if (msg && msg.role && msg.content) {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    });
  }

  if (formattedMessages.length === 0) {
    formattedMessages.push({ role: 'system', content: 'You are AgentX, an efficient local AI assistant.' });
  }

  const payload = {
    model,
    messages: formattedMessages,
    stream: false,
    options: sanitizeOptions(options),
  };

  try {
    const result = await proxyOllama('/api/chat', target, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    res.json({ status: 'success', data: result });
  } catch (err) {
    res.status(err.status || 500).json(buildErrorResponse(err));
  }
});

// ========== V1: ENHANCED CHAT WITH LOGGING ==========

app.post('/api/chat', async (req, res) => {
  const {
    userId = 'default',
    conversationId,
    message,
    model,
    target = 'localhost:11434',
    system,
    options = {},
  } = req.body || {};

  // Validation
  if (!message || !message.trim()) {
    return res.status(400).json({ status: 'error', message: 'Message is required' });
  }
  if (!model) {
    return res.status(400).json({ status: 'error', message: 'Model is required' });
  }

  const startTime = Date.now();

  try {
    // Get or create user profile for memory injection
    const userProfile = await db.getOrCreateUserProfile(userId);

    // Build system prompt with user memory
    let enhancedSystem = system || 'You are AgentX, an efficient local AI assistant.';
    
    if (userProfile) {
      const memoryContext = buildMemoryContext(userProfile);
      if (memoryContext) {
        enhancedSystem += `\n\n${memoryContext}`;
      }
    }

    // Get or create conversation
    let conversation;
    if (conversationId) {
      conversation = await db.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ status: 'error', message: 'Conversation not found' });
      }
    } else {
      // Create new conversation
      conversation = await db.createConversation({
        user_id: userId,
        model,
        system_prompt: enhancedSystem,
        target,
        title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
      });
    }

    // Get existing messages for context
    const existingMessages = await db.getConversationMessages(conversation.id);
    
    // Build messages array for LLM
    const formattedMessages = [{ role: 'system', content: enhancedSystem }];
    
    // Add conversation history (excluding system messages from history)
    existingMessages.forEach((msg) => {
      if (msg.role !== 'system') {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    });
    
    // Add new user message
    formattedMessages.push({ role: 'user', content: message });

    // Store user message
    const userMessage = await db.createMessage({
      conversation_id: conversation.id,
      role: 'user',
      content: message,
    });

    // Call LLM
    const payload = {
      model,
      messages: formattedMessages,
      stream: false,
      options: sanitizeOptions(options),
    };

    const result = await proxyOllama('/api/chat', target, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const latencyMs = Date.now() - startTime;

    // Store assistant response
    const assistantMessage = await db.createMessage({
      conversation_id: conversation.id,
      role: 'assistant',
      content: result.message?.content || '',
    });

    // Store LLM metadata
    await db.createLLMMetadata({
      message_id: assistantMessage.id,
      model: result.model || model,
      temperature: options.temperature,
      top_p: options.top_p,
      top_k: options.top_k,
      num_ctx: options.num_ctx,
      tokens_prompt: result.prompt_eval_count,
      tokens_completion: result.eval_count,
      tokens_total: (result.prompt_eval_count || 0) + (result.eval_count || 0),
      latency_ms: latencyMs,
      options_json: options,
    });

    // Update conversation timestamp
    await db.touchConversation(conversation.id);

    // Build response
    res.json({
      status: 'success',
      data: {
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        response: result.message?.content || '',
        metadata: {
          model: result.model || model,
          latency_ms: latencyMs,
          tokens: {
            prompt: result.prompt_eval_count,
            completion: result.eval_count,
            total: (result.prompt_eval_count || 0) + (result.eval_count || 0),
          },
          done: result.done,
          done_reason: result.done_reason,
        },
      },
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(err.status || 500).json(buildErrorResponse(err));
  }
});

// ========== V1: CONVERSATION RETRIEVAL ==========

app.get('/api/conversations', async (req, res) => {
  try {
    const userId = req.query.userId || 'default';
    const limit = parseInt(req.query.limit) || 50;

    const conversations = await db.getUserConversations(userId, limit);

    res.json({
      status: 'success',
      data: conversations,
    });
  } catch (err) {
    console.error('Get conversations error:', err);
    res.status(500).json(buildErrorResponse(err));
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const conversationId = req.params.id;
    const includeMessages = req.query.includeMessages !== 'false';

    const conversation = await db.getConversation(conversationId);
    if (!conversation) {
      return res.status(404).json({ status: 'error', message: 'Conversation not found' });
    }

    if (includeMessages) {
      const messages = await db.getConversationMessages(conversationId);
      res.json({
        status: 'success',
        data: {
          ...conversation,
          messages,
        },
      });
    } else {
      res.json({
        status: 'success',
        data: conversation,
      });
    }
  } catch (err) {
    console.error('Get conversation error:', err);
    res.status(500).json(buildErrorResponse(err));
  }
});

app.patch('/api/conversations/:id', async (req, res) => {
  try {
    const conversationId = req.params.id;
    const { title } = req.body;

    if (!title) {
      return res.status(400).json({ status: 'error', message: 'Title is required' });
    }

    const conversation = await db.getConversation(conversationId);
    if (!conversation) {
      return res.status(404).json({ status: 'error', message: 'Conversation not found' });
    }

    await db.updateConversationTitle(conversationId, title);

    res.json({
      status: 'success',
      data: await db.getConversation(conversationId),
    });
  } catch (err) {
    console.error('Update conversation error:', err);
    res.status(500).json(buildErrorResponse(err));
  }
});

// ========== V2: USER PROFILE / MEMORY ==========

app.get('/api/user/profile', async (req, res) => {
  try {
    const userId = req.query.userId || 'default';
    const profile = await db.getOrCreateUserProfile(userId);

    // Parse custom_preferences if it's JSON string
    if (profile.custom_preferences && typeof profile.custom_preferences === 'string') {
      try {
        profile.custom_preferences = JSON.parse(profile.custom_preferences);
      } catch (e) {
        // Leave as string if not valid JSON
      }
    }

    res.json({
      status: 'success',
      data: profile,
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json(buildErrorResponse(err));
  }
});

app.post('/api/user/profile', async (req, res) => {
  try {
    const userId = req.body.userId || 'default';
    const updates = req.body;

    // Remove userId from updates to avoid confusion
    delete updates.userId;

    const profile = await db.updateUserProfile(userId, updates);

    // Parse custom_preferences if it's JSON string
    if (profile.custom_preferences && typeof profile.custom_preferences === 'string') {
      try {
        profile.custom_preferences = JSON.parse(profile.custom_preferences);
      } catch (e) {
        // Leave as string if not valid JSON
      }
    }

    res.json({
      status: 'success',
      data: profile,
    });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json(buildErrorResponse(err));
  }
});

// ========== V2: FEEDBACK ==========

app.post('/api/feedback', async (req, res) => {
  try {
    const { messageId, rating, comment } = req.body;

    if (!messageId) {
      return res.status(400).json({ status: 'error', message: 'Message ID is required' });
    }

    if (rating === undefined || rating === null) {
      return res.status(400).json({ status: 'error', message: 'Rating is required' });
    }

    // Validate rating
    if (![-1, 0, 1].includes(rating)) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Rating must be -1 (down), 0 (neutral), or 1 (up)' 
      });
    }

    const feedback = await db.createFeedback({
      message_id: messageId,
      rating,
      comment,
    });

    res.json({
      status: 'success',
      data: feedback,
    });
  } catch (err) {
    console.error('Create feedback error:', err);
    if (err.message === 'Message not found') {
      return res.status(404).json({ status: 'error', message: err.message });
    }
    res.status(500).json(buildErrorResponse(err));
  }
});

app.get('/api/feedback/message/:messageId', async (req, res) => {
  try {
    const messageId = req.params.messageId;
    const feedback = await db.getMessageFeedback(messageId);

    res.json({
      status: 'success',
      data: feedback,
    });
  } catch (err) {
    console.error('Get message feedback error:', err);
    res.status(500).json(buildErrorResponse(err));
  }
});

app.get('/api/feedback/conversation/:conversationId', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    const feedback = await db.getConversationFeedback(conversationId);

    res.json({
      status: 'success',
      data: feedback,
    });
  } catch (err) {
    console.error('Get conversation feedback error:', err);
    res.status(500).json(buildErrorResponse(err));
  }
});

// ========== HELPER FUNCTIONS ==========

/**
 * Build memory context string from user profile
 * @param {object} profile - User profile
 * @returns {string} Memory context for system prompt
 */
function buildMemoryContext(profile) {
  const parts = [];

  if (profile.name && profile.name !== 'User') {
    parts.push(`User's name: ${profile.name}`);
  }

  if (profile.role) {
    parts.push(`User's role: ${profile.role}`);
  }

  if (profile.language_preference && profile.language_preference !== 'en') {
    parts.push(`Preferred language: ${profile.language_preference}`);
  }

  const styleMap = {
    concise: 'The user prefers concise, brief responses.',
    detailed: 'The user prefers detailed, comprehensive responses.',
    balanced: 'The user prefers balanced responses.',
  };
  if (profile.response_style && styleMap[profile.response_style]) {
    parts.push(styleMap[profile.response_style]);
  }

  const codeMap = {
    'code-heavy': 'The user prefers code-heavy responses with practical examples.',
    'conceptual': 'The user prefers conceptual explanations over code examples.',
    balanced: 'The user prefers a balance of code and conceptual explanations.',
  };
  if (profile.code_preference && codeMap[profile.code_preference]) {
    parts.push(codeMap[profile.code_preference]);
  }

  // Parse custom preferences if available
  if (profile.custom_preferences) {
    try {
      const custom = typeof profile.custom_preferences === 'string' 
        ? JSON.parse(profile.custom_preferences) 
        : profile.custom_preferences;
      
      if (custom.notes) {
        parts.push(`Additional notes: ${custom.notes}`);
      }
    } catch (e) {
      // Ignore parsing errors
    }
  }

  if (parts.length === 0) {
    return '';
  }

  return `User Profile:\n${parts.join('\n')}`;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AgentX control running on http://localhost:${PORT}`);
});

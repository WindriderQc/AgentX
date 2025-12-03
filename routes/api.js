const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const UserProfile = require('../models/UserProfile');
const PromptConfig = require('../models/PromptConfig'); // V4: Import prompt versioning
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

// Helper to sanitize Ollama options
function sanitizeOptions(options = {}) {
  const numericKeys = [
    'temperature', 'top_k', 'top_p', 'num_ctx', 'repeat_penalty',
    'presence_penalty', 'frequency_penalty', 'seed', 'num_predict',
    'typical_p', 'tfs_z', 'mirostat', 'mirostat_eta', 'mirostat_tau'
  ];
  const clean = {};
  numericKeys.forEach((key) => {
    if (options[key] === 0 || options[key]) {
      const parsed = Number(options[key]);
      if (!Number.isNaN(parsed)) clean[key] = parsed;
    }
  });
  if (Array.isArray(options.stop)) clean.stop = options.stop;
  else if (typeof options.stop === 'string' && options.stop.trim()) {
    clean.stop = options.stop.split(',').map((val) => val.trim()).filter(Boolean);
  }
  if (options.keep_alive) clean.keep_alive = options.keep_alive;
  return clean;
}

// Resolve Ollama Target
function resolveTarget(target) {
    const fallback = 'http://localhost:11434';
    if (!target || typeof target !== 'string') return fallback;
    const trimmed = target.trim();
    if (!trimmed) return fallback;
    if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
    return `http://${trimmed.replace(/\/+$/, '')}`;
}

// PROXY: Models List
router.get('/ollama/models', async (req, res) => {
    const target = req.query.target || 'localhost:11434';
    try {
        const url = `${resolveTarget(target)}/api/tags`;
        const response = await fetch(url);
        const data = await response.json();
        const models = Array.isArray(data?.models)
            ? data.models.map((model) => ({
                name: model.name,
                size: model.size,
                modified_at: model.modified_at,
            }))
            : [];
        res.json({ status: 'success', data: models });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// V3: Import RAG Store
const { getRagStore } = require('../src/services/ragStore');
const ragStore = getRagStore();

// CHAT: Enhanced with Memory & Logging + V3 RAG Support + V4 Prompt Versioning
router.post('/chat', async (req, res) => {
  const { target = 'localhost:11434', model, messages = [], system, options = {}, conversationId, useRag, ragTopK, ragFilters } = req.body;
  const userId = 'default'; // Hardcoded for single user V1/V2

  if (!model) return res.status(400).json({ status: 'error', message: 'Model is required' });

  try {
    // V4: Fetch active prompt configuration (with timeout fallback for SQLite)
    let activePrompt;
    try {
      activePrompt = await Promise.race([
        PromptConfig.getActive('default_chat'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
      ]);
    } catch (err) {
      // Fallback: use default prompt when MongoDB not available
      activePrompt = { 
        systemPrompt: system || 'You are AgentX, a helpful AI assistant.',
        version: 'default'
      };
    }

    // V3: RAG variables
    let ragUsed = false;
    let ragSources = [];

    // 1. Fetch User Profile (with timeout fallback for SQLite)
    let userProfile;
    try {
      userProfile = await Promise.race([
        UserProfile.findOne({ userId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
      ]);
      if (!userProfile) {
        userProfile = { about: '', preferences: {} };
      }
    } catch (err) {
      // Fallback: empty profile when MongoDB not available
      userProfile = { about: '', preferences: {} };
    }

    // 2. Inject Memory into System Prompt (V4: Use active prompt as base)
    let effectiveSystemPrompt = system || activePrompt.systemPrompt;
    if (userProfile.about) {
        effectiveSystemPrompt += `\n\nUser Profile/Memory:\n${userProfile.about}`;
    }
    if (userProfile.preferences?.customInstructions) {
        effectiveSystemPrompt += `\n\nCustom Instructions:\n${userProfile.preferences.customInstructions}`;
    }

    // V3: RAG Context Injection
    if (useRag === true && messages.length > 0) {
      try {
        // Extract query from last user message
        const lastUserMsg = messages[messages.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
          const query = lastUserMsg.content;
          
          // Resolve Ollama host for RAG embeddings
          const ollamaHost = resolveTarget(target);
          
          // Search for relevant chunks
          const searchResults = await ragStore.searchSimilarChunks(query, {
            topK: ragTopK || 5,
            minScore: 0.3, // Reasonable threshold
            filters: ragFilters,
            ollamaHost
          });

          if (searchResults.length > 0) {
            ragUsed = true;
            
            // Build context section
            let contextSection = '\n\n=== Retrieved Context ===\n';
            searchResults.forEach((result, idx) => {
              contextSection += `\n[Source ${idx + 1}: ${result.metadata.title}]\n`;
              contextSection += `${result.text}\n`;
              
              // Store for response
              ragSources.push({
                text: result.text.substring(0, 200), // Truncate for response
                score: result.score,
                source: result.metadata.source,
                title: result.metadata.title,
                documentId: result.metadata.documentId
              });
            });
            contextSection += '\n=== End Context ===\n';
            
            // Prepend context to system prompt
            effectiveSystemPrompt = contextSection + '\n' + effectiveSystemPrompt;
            
            console.log(`[Chat RAG] Injected ${searchResults.length} chunks for query: "${query}"`);
          }
        }
      } catch (ragError) {
        console.error('[Chat RAG] Error during RAG retrieval:', ragError);
        // Continue without RAG rather than failing the whole request
        ragUsed = false;
        ragSources = [];
      }
    }

    // 3. Prepare Payload for Ollama
    const formattedMessages = [
        { role: 'system', content: effectiveSystemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    const ollamaPayload = {
        model,
        messages: formattedMessages,
        stream: false,
        options: sanitizeOptions(options),
    };

    // 4. Call Ollama
    const url = `${resolveTarget(target)}/api/chat`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaPayload),
    });

    if (!response.ok) throw new Error(`Ollama request failed: ${response.statusText}`);
    const data = await response.json();
    const assistantMessageContent = data.message?.content || data.response || '';

    // 5. Save to DB (with timeout fallback for SQLite)
    let conversation;
    try {
      if (conversationId) {
          conversation = await Promise.race([
            Conversation.findById(conversationId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
          ]);
      }

      // If no ID or not found, create new
      if (!conversation) {
          conversation = new Conversation({
              userId,
              model,
              systemPrompt: effectiveSystemPrompt,
              messages: []
          });
      }

      const lastUserMsg = messages[messages.length - 1];
      if (lastUserMsg && lastUserMsg.role === 'user') {
           conversation.messages.push({ role: 'user', content: lastUserMsg.content });
      }

      conversation.messages.push({ role: 'assistant', content: assistantMessageContent });

      // Generate title if new
      if (conversation.messages.length <= 2) {
          conversation.title = (lastUserMsg?.content || 'New Conversation').substring(0, 50);
      }

      // V3: Store RAG metadata
      conversation.ragUsed = ragUsed;
      conversation.ragSources = ragSources;

      // V4: Store prompt version info
      conversation.promptConfigId = activePrompt._id;
      conversation.promptName = activePrompt.name;
      conversation.promptVersion = activePrompt.version;

      await Promise.race([
        conversation.save(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
      ]);
    } catch (err) {
      // Silently skip conversation save when MongoDB not available
      console.log('[Chat] Conversation save skipped (MongoDB not available)');
    }

    // 6. Return response (V3: includes RAG fields)
    res.json({
        status: 'success',
        data: data,
        conversationId: conversation._id,
        ragUsed,        // V3 addition
        ragSources      // V3 addition
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// HISTORY: Get list
router.get('/history', async (req, res) => {
    try {
        const conversations = await Promise.race([
            Conversation.find({ userId: 'default' })
                .sort({ updatedAt: -1 })
                .limit(50)
                .select('title updatedAt model messages'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
        ]);

        // Transform for frontend preview
        const previews = conversations.map(c => ({
            id: c._id,
            title: c.title,
            date: c.updatedAt,
            model: c.model,
            preview: c.messages[c.messages.length - 1]?.content.substring(0, 60) + '...'
        }));

        res.json({ status: 'success', data: previews });
    } catch (err) {
        if (err.message.includes('buffering timed out') || err.message.includes('DB timeout')) {
            res.json({ status: 'success', data: [] });
        } else {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
});

// HISTORY: Get single
router.get('/history/:id', async (req, res) => {
    try {
        const conversation = await Conversation.findById(req.params.id);
        if(!conversation) return res.status(404).json({status: 'error', message: 'Not found'});
        res.json({ status: 'success', data: conversation });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// FEEDBACK
router.post('/feedback', async (req, res) => {
    const { conversationId, messageId, rating, comment } = req.body;
    try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) return res.status(404).json({ status: 'error', message: 'Conversation not found' });

        // Find the message. Since we might not have stable IDs for subdocuments if we just push,
        // we can use the `_id` of the subdocument if Mongoose adds it (it does by default).
        const msg = conversation.messages.id(messageId);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Message not found' });

        msg.feedback = { rating, comment };
        await conversation.save();

        res.json({ status: 'success', message: 'Feedback saved' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// LOGS - fallback endpoint for session logs
router.get('/logs', async (req, res) => {
    // With SQLite, we don't persist chat logs server-side
    // Return empty to let client use local state
    res.json({ status: 'success', data: { messages: [] } });
});

// PROFILE
router.get('/profile', async (req, res) => {
    try {
        const profile = await Promise.race([
            UserProfile.findOne({ userId: 'default' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
        ]);
        res.json({ status: 'success', data: profile || { userId: 'default', about: '', preferences: {} } });
    } catch (err) {
        // Return empty profile when MongoDB not available
        if (err.message.includes('buffering timed out') || err.message.includes('DB timeout')) {
            res.json({ status: 'success', data: { userId: 'default', about: '', preferences: {} } });
        } else {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
});

router.post('/profile', async (req, res) => {
    const { about, preferences } = req.body;
    try {
        const profile = await Promise.race([
            UserProfile.findOneAndUpdate(
                { userId: 'default' },
                { $set: { about, preferences, updatedAt: Date.now() } },
                { new: true, upsert: true }
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 1000))
        ]);
        res.json({ status: 'success', data: profile });
    } catch (err) {
        if (err.message.includes('buffering timed out') || err.message.includes('DB timeout')) {
            res.json({ status: 'success', data: { userId: 'default', about, preferences } });
        } else {
            res.status(500).json({ status: 'error', message: err.message });
        }
    }
});

module.exports = router;

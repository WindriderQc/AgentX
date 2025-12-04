const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const UserProfile = require('../models/UserProfile');
const PromptConfig = require('../models/PromptConfig'); // V4: Import prompt versioning
const { sanitizeOptions, resolveTarget } = require('../src/utils');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

// PROXY: Models List
router.get('/ollama/models', async (req, res) => {
    const target = req.query.target || process.env.OLLAMA_HOST || 'localhost:11434';
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
  const { target = process.env.OLLAMA_HOST || 'localhost:11434', model, messages = [], system, options = {}, conversationId, useRag, ragTopK, ragFilters } = req.body;
  const userId = 'default'; // Hardcoded for single user V1/V2

  if (!model) return res.status(400).json({ status: 'error', message: 'Model is required' });
  if (!message) return res.status(400).json({ status: 'error', message: 'Message is required' });

  try {
    // V4: Fetch active prompt configuration
    let activePrompt;
    try {
      activePrompt = await PromptConfig.getActive('default_chat');
      if (!activePrompt) {
        // Fallback: use default prompt
        activePrompt = { 
          systemPrompt: system || 'You are AgentX, a helpful AI assistant.',
          version: 'default'
        };
      }
    } catch (err) {
      // Fallback: use default prompt when DB error
      activePrompt = { 
        systemPrompt: system || 'You are AgentX, a helpful AI assistant.',
        version: 'default'
      };
    }

    // V3: RAG variables
    let ragUsed = false;
    let ragSources = [];

    // 1. Fetch User Profile
    let userProfile;
    try {
      userProfile = await UserProfile.findOne({ userId });
      if (!userProfile) {
        userProfile = await UserProfile.create({ userId });
      }
    } catch (err) {
      // Fallback: empty profile when DB error
      console.log('[Chat] UserProfile fetch failed:', err.message);
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
    if (useRag === true && message) {
      try {
        // Use the current message as the query
        const query = message;
          
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

    // 4. Call Ollama with timeout
    const url = `${resolveTarget(target)}/api/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout
    
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaPayload),
            signal: controller.signal
        });
    } catch (fetchError) {
        clearTimeout(timeout);
        if (fetchError.name === 'AbortError') {
            throw new Error('Ollama request timed out after 2 minutes. The model may be too large or the server is overloaded.');
        }
        throw new Error(`Failed to connect to Ollama at ${url}: ${fetchError.message}`);
    }
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`Ollama request failed: ${response.statusText}`);
    const data = await response.json();
    const assistantMessageContent = data.message?.content || data.response || '';

    // 5. Save to DB
    let conversation;
    try {
      if (conversationId) {
          conversation = await Conversation.findById(conversationId);
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

      // Add the user's message (from request body, not from history)
      if (message && message.trim()) {
           conversation.messages.push({ role: 'user', content: message.trim() });
      }

      // Add the assistant's response
      if (assistantMessageContent && assistantMessageContent.trim()) {
          conversation.messages.push({ role: 'assistant', content: assistantMessageContent.trim() });
      }

      // Generate title if new (use the current message)
      if (conversation.messages.length <= 2) {
          conversation.title = (message || 'New Conversation').substring(0, 50);
      }

      // V3: Store RAG metadata
      conversation.ragUsed = ragUsed;
      conversation.ragSources = ragSources;

      // V4: Store prompt version info
      conversation.promptConfigId = activePrompt._id;
      conversation.promptName = activePrompt.name;
      conversation.promptVersion = activePrompt.version;

      await conversation.save();
    } catch (err) {
      console.error('[Chat] Failed to save conversation:', err.message);
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
        const conversations = await Conversation.find({ userId: 'default' })
            .sort({ updatedAt: -1 })
            .limit(50)
            .select('title updatedAt model messages');

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
        res.status(500).json({ status: 'error', message: err.message });
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
        let profile = await UserProfile.findOne({ userId: 'default' });
        if (!profile) profile = await UserProfile.create({ userId: 'default' });
        res.json({ status: 'success', data: profile });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/profile', async (req, res) => {
    const { about, preferences } = req.body;
    try {
        const profile = await UserProfile.findOneAndUpdate(
            { userId: 'default' },
            { $set: { about, preferences, updatedAt: Date.now() } },
            { new: true, upsert: true }
        );
        res.json({ status: 'success', data: profile });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;

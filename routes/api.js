const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const UserProfile = require('../models/UserProfile');
const PromptConfig = require('../models/PromptConfig'); // V4: Import prompt versioning
const { sanitizeOptions, resolveTarget } = require('../src/utils');
const { optionalAuth, apiKeyAuth } = require('../src/middleware/auth');
const { getUserId, getOrCreateProfile } = require('../src/helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../src/helpers/ollamaResponseHandler');
const logger = require('../config/logger');
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

// V3: Import RAG Store with environment config
const { getRagStore } = require('../src/services/ragStore');
const ragStore = getRagStore({
  vectorStoreType: process.env.VECTOR_STORE_TYPE || 'memory',
  url: process.env.QDRANT_URL,
  collection: process.env.QDRANT_COLLECTION
});

// CHAT: Enhanced with Memory & Logging + V3 RAG Support + V4 Prompt Versioning
// Allow both session auth and API key for automation
router.post('/chat', optionalAuth, async (req, res) => {
  const { target = process.env.OLLAMA_HOST || 'localhost:11434', model, message, messages = [], system, options = {}, conversationId, useRag, ragTopK, ragFilters } = req.body;
  const userId = getUserId(res);

  if (!model) return res.status(400).json({ status: 'error', message: 'Model is required' });
  if (!message) return res.status(400).json({ status: 'error', message: 'Message is required' });

  // Detect models with thinking/reasoning capabilities
  const thinkingModels = [
    'qwen', 'deepseek-r1', 'deepthink', 'o1', 'o3', 'reasoning'
  ];
  const isThinkingModel = thinkingModels.some(pattern => 
    model.toLowerCase().includes(pattern)
  );

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
    const userProfile = await getOrCreateProfile(userId);

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
            
            logger.info('RAG context injected', {
              chunkCount: searchResults.length,
              query: query.substring(0, 50)
            });
          }
      } catch (ragError) {
        logger.error('RAG retrieval error', { error: ragError.message, stack: ragError.stack });
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

    const ollamaPayload = buildOllamaPayload({
        model,
        messages: formattedMessages,
<<<<<<< HEAD
        stream: false,
        options: {
            ...sanitizeOptions(options),
            // Ensure we get complete responses (no truncation)
            num_predict: options?.num_predict || 4096, // High limit to avoid truncation
        },
    };
=======
        options: sanitizeOptions(options),
        streamEnabled: false
    });
>>>>>>> 5d81f19 (Global clean)

    // 4. Call Ollama with timeout (use streaming for models with thinking)
    const url = `${resolveTarget(target)}/api/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout
    
    let response;
    try {
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ollamaPayload),
                signal: controller.signal
            });
        } catch (fetchError) {
            if (fetchError.name === 'AbortError') {
                throw new Error('Ollama request timed out after 2 minutes. The model may be too large or the server is overloaded.');
            }
            throw new Error(`Failed to connect to Ollama at ${url}: ${fetchError.message}`);
        }

        if (!response.ok) throw new Error(`Ollama request failed: ${response.statusText}`);
    } finally {
        clearTimeout(timeout);
    }
    
    // For non-streaming responses, parse JSON and extract content
    const data = await response.json();
    const { content: assistantMessageContent, thinking, warning } = extractResponse(data, model);
    
<<<<<<< HEAD
    // Check if response indicates streaming is needed (done: false means incomplete)
    if (data.done === false) {
      logger.warn('Incomplete response received', { model, message: 'Model may require streaming' });
    }
    
    // Handle different response formats
    let assistantMessageContent = '';
    const hasContent = data.message?.content && data.message.content.trim() !== '';
    const hasThinking = data.message?.thinking && data.message.thinking.trim() !== '';
    const hasResponse = data.response && data.response.trim() !== '';
    
    // Debug logging to understand the response structure
    logger.debug('Ollama response structure', { 
      model,
      hasContent,
      contentLength: data.message?.content?.length || 0,
      hasThinking,
      thinkingLength: data.message?.thinking?.length || 0,
      hasResponse,
      done: data.done
    });

    // Priority: Use content if available, otherwise response, otherwise thinking
    if (hasContent) {
      let content = data.message.content;
      
      // For models with thinking (Qwen, DeepSeek-R1), extract response after thinking
      // Pattern: thinking ends with multiple newlines or specific markers, then response starts
      if (hasThinking || content.includes('Okay,') || content.includes('Let me think')) {
        // Try to find where thinking ends and response begins
        // Look for patterns like double newlines, numbered sections, or response markers
        const thinkingEndMarkers = [
          /\n{3,}/,  // 3+ newlines
          /\n\n---\n/,  // Separator
          /\n\n\*\*Response:\*\*/i,  // "Response:" header
          /\n\n\*\*Answer:\*\*/i,   // "Answer:" header
        ];
        
        for (const marker of thinkingEndMarkers) {
          const parts = content.split(marker);
          if (parts.length > 1 && parts[parts.length - 1].trim().length > 50) {
            // Found a marker and there's substantial content after it
            content = parts[parts.length - 1].trim();
            logger.info('Extracted response from thinking content', {
              model,
              originalLength: data.message.content.length,
              extractedLength: content.length
            });
            break;
          }
        }
      }
      
      assistantMessageContent = content;
    } else if (hasResponse) {
      assistantMessageContent = data.response;
    } else if (hasThinking) {
      // Fallback to thinking if no content (model might be in thinking-only mode)
      logger.warn('Using thinking as response', { model, reason: 'No content field' });
      assistantMessageContent = data.message.thinking;
    }

    // Log if still empty
    if (!assistantMessageContent || assistantMessageContent.trim() === '') {
      logger.error('Empty response from Ollama', { 
        model, 
        fullResponse: JSON.stringify(data)
      });
=======
    // Log warnings if any
    if (warning) {
      logger.warn('Response extraction warning', { model, warning });
>>>>>>> 5d81f19 (Global clean)
    }

    // 5. Save to DB
    let conversation;
    let assistantMessageId = null;
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

      // Add the assistant's response and capture its ID
      if (assistantMessageContent && assistantMessageContent.trim()) {
          const contentToSave = assistantMessageContent.trim();
          logger.debug('Saving assistant message', { 
            model,
            contentLength: contentToSave.length,
            hasThinking: !!thinking,
            preview: contentToSave.substring(0, 100) + '...'
          });
          const assistantMsg = conversation.messages.create({ 
            role: 'assistant', 
            content: contentToSave 
          });
          // Store thinking process as metadata if available
          if (thinking) {
            assistantMsg.metadata = assistantMsg.metadata || {};
            assistantMsg.metadata.thinking = thinking;
          }
          conversation.messages.push(assistantMsg);
          assistantMessageId = assistantMsg._id;
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
      logger.error('Failed to save conversation', { error: err.message, stack: err.stack });
    }

    // 6. Return response (V3: includes RAG fields)
    const responsePayload = {
        status: 'success',
        data: {
            response: assistantMessageContent || '',
            conversationId: conversation?._id || null,
            messageId: assistantMessageId
        },
        ragUsed,        // V3 addition
        ragSources,     // V3 addition
        // Warning for thinking models without streaming
        ...(isThinkingModel && {
          warning: 'This model has thinking capabilities. Enable streaming for better response quality and to see the reasoning process.'
        })
    };

    // Log if response is empty to help debugging
    if (!assistantMessageContent || assistantMessageContent.trim() === '') {
      logger.error('Returning empty response to client', {
        conversationId: conversation?._id,
        model,
        messageLength: message?.length
      });
    }

    res.json(responsePayload);

  } catch (err) {
    logger.error('Chat error', { error: err.message, stack: err.stack });
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
        let conversation;
        
        // If conversationId provided, use it directly
        if (conversationId) {
            conversation = await Conversation.findById(conversationId);
        } else if (messageId) {
            // Otherwise, find conversation containing this messageId
            conversation = await Conversation.findOne({ 'messages._id': messageId });
        }
        
        if (!conversation) return res.status(404).json({ status: 'error', message: 'Conversation not found' });

        // Find the message by ID
        const msg = conversation.messages.id(messageId);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Message not found' });

        msg.feedback = { rating, comment };
        await conversation.save();

        res.json({ status: 'success', message: 'Feedback saved' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// LOGS - Get latest conversation messages
router.get('/logs', async (req, res) => {
    try {
        const conversation = await Conversation.findOne({ userId: 'default' })
            .sort({ updatedAt: -1 });

        if (!conversation) {
            return res.json({ status: 'success', data: { messages: [] } });
        }
        res.json({ status: 'success', data: { messages: conversation.messages } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// PROFILE
router.get('/profile', async (req, res) => {
    try {
        const profile = await getOrCreateProfile('default');
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

// Route aliases for backwards compatibility with test scripts
router.get('/conversations', optionalAuth, async (req, res) => {
    try {
        const userId = getUserId(res);
        const conversations = await Conversation.find({ userId })
            .sort({ updatedAt: -1 })
            .limit(50)
            .select('title updatedAt model messages');

        const previews = conversations.map(c => ({
            id: c._id,
            title: c.title,
            date: c.updatedAt,
            model: c.model,
            messageCount: c.messages.length
        }));

        res.json({ status: 'success', data: previews });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/conversations/:id', optionalAuth, async (req, res) => {
    try {
        const userId = getUserId(res);
        const conversation = await Conversation.findById(req.params.id);
        if (!conversation) return res.status(404).json({ status: 'error', message: 'Not found' });
        // Verify user owns this conversation
        if (conversation.userId !== userId && userId !== 'default') {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }
        res.json({ status: 'success', data: conversation });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/user/profile', optionalAuth, async (req, res) => {
    try {
        const userId = getUserId(res);
        const profile = await getOrCreateProfile(userId);
        res.json({ status: 'success', data: profile });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;

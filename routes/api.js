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
const { dataapi, DataApiError } = require('../src/services/dataapiClient');

// DataAPI tool proxy (server-side) - keeps DATAAPI_API_KEY off the browser.
router.get('/dataapi/info', optionalAuth, (req, res) => {
    const baseUrl = process.env.DATAAPI_BASE_URL || null;
    res.json({ status: 'success', data: { baseUrl } });
});

router.get('/dataapi/files/search', optionalAuth, async (req, res) => {
    try {
        const { q, limit, skip } = req.query;
        const result = await dataapi.files.search({
            q: q || '',
            limit: limit !== undefined ? Number(limit) : undefined,
            skip: skip !== undefined ? Number(skip) : undefined
        });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/files/duplicates', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.duplicates();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/files/stats', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.stats();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/files/tree', optionalAuth, async (req, res) => {
    try {
        const { root } = req.query;
        const result = await dataapi.files.tree({ root: root || '/' });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/files/cleanup-recommendations', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.cleanupRecommendations();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/files/exports', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.files.exportsList();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/files/export-optimized', optionalAuth, async (req, res) => {
    try {
        const { type } = req.query;
        const result = await dataapi.files.exportOptimized({ type: type || 'summary' });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/dataapi/storage/scan', optionalAuth, async (req, res) => {
    try {
        const { roots, extensions, batch_size } = req.body || {};
        const result = await dataapi.storage.scanStart({ roots, extensions, batch_size });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/storage/scans', optionalAuth, async (req, res) => {
    try {
        const { limit, skip } = req.query;
        const result = await dataapi.storage.scansList({
            limit: limit !== undefined ? Number(limit) : undefined,
            skip: skip !== undefined ? Number(skip) : undefined
        });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/storage/status/:scan_id', optionalAuth, async (req, res) => {
    try {
        const { scan_id } = req.params;
        const result = await dataapi.storage.scanStatus({ scan_id });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/dataapi/storage/stop/:scan_id', optionalAuth, async (req, res) => {
    try {
        const { scan_id } = req.params;
        const result = await dataapi.storage.scanStop({ scan_id });
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/live/iss', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.live.iss();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/dataapi/live/quakes', optionalAuth, async (_req, res) => {
    try {
        const result = await dataapi.live.quakes();
        return res.json({ status: 'success', data: result });
    } catch (err) {
        if (err instanceof DataApiError) {
            return res.status(err.status || 502).json({ status: 'error', message: err.message, details: err.body || null });
        }
        return res.status(500).json({ status: 'error', message: err.message });
    }
});

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

    // Minimal, explicit tool bridge (no surprise routing):
    // Users can run DataAPI tooling from AgentX chat using slash commands.
    // Examples:
    //   /dataapi files search invoice 2024
    //   /dataapi files duplicates
    //   /dataapi storage scan {"roots":["/mnt/smb/Media"],"extensions":["mp4"],"batch_size":1000}
    //   /dataapi storage status <scan_id>
    async function tryHandleToolCommand(rawMessage) {
        const m = String(rawMessage || '').trim();
        if (!m.startsWith('/dataapi')) return null;

        const parts = m.split(/\s+/);
        // parts[0] == /dataapi
        const domain = parts[1];
        const action = parts[2];
        const rest = parts.slice(3).join(' ').trim();

        if (!domain || !action) {
            return {
                ok: false,
                responseText: 'Usage: /dataapi <files|storage|live> <action> [args]'
            };
        }

        try {
            // FILES
            if (domain === 'files' && action === 'search') {
                if (!rest) return { ok: false, responseText: 'Usage: /dataapi files search <query>' };
                const result = await dataapi.files.search({ q: rest, limit: 50, skip: 0 });
                const hits = result?.data?.results || [];
                const preview = hits.slice(0, 10).map(f => `- ${f.path} (${f.sizeFormatted || f.size || 'n/a'})`).join('\n');
                return {
                    ok: true,
                    responseText: `DataAPI files.search("${rest}")\n\nTop results:\n${preview || '(no matches)'}\n\nTotal: ${result?.data?.pagination?.total ?? 'n/a'}`,
                    tool: { name: 'dataapi.files.search', args: { q: rest } },
                    toolResult: result
                };
            }

            if (domain === 'files' && action === 'duplicates') {
                const result = await dataapi.files.duplicates();
                const groups = result?.data?.duplicates || [];
                const summary = result?.data?.summary;
                const preview = groups.slice(0, 5).map(g => `- ${g.filename} (${g.sizeFormatted}) x${g.count} wasted ${g.wastedSpaceFormatted}`).join('\n');
                return {
                    ok: true,
                    responseText: `DataAPI files.duplicates\n\n${preview || '(no duplicates found in top set)'}\n\nWasted: ${summary?.totalWastedSpaceFormatted || 'n/a'} in ${summary?.totalDuplicateGroups ?? 'n/a'} groups`,
                    tool: { name: 'dataapi.files.duplicates', args: {} },
                    toolResult: result
                };
            }

            if (domain === 'files' && action === 'export') {
                // /dataapi files export <type> [json|csv]
                const [type = 'summary', format = 'json'] = rest.split(/\s+/).filter(Boolean);
                const result = await dataapi.files.export({ type, format });
                return {
                    ok: true,
                    responseText: `DataAPI files.export(type=${type}, format=${format})\n\n${JSON.stringify(result?.data || result, null, 2)}`,
                    tool: { name: 'dataapi.files.export', args: { type, format } },
                    toolResult: result
                };
            }

            // STORAGE
            if (domain === 'storage' && action === 'scan') {
                if (!rest) return { ok: false, responseText: 'Usage: /dataapi storage scan <jsonBody>' };
                let payload;
                try {
                    payload = JSON.parse(rest);
                } catch (e) {
                    return { ok: false, responseText: `Invalid JSON: ${e.message}` };
                }
                const result = await dataapi.storage.scanStart(payload);
                return {
                    ok: true,
                    responseText: `DataAPI storage.scanStart\n\nScan started. scan_id=${result?.data?.scan_id || '(unknown)'}`,
                    tool: { name: 'dataapi.storage.scanStart', args: payload },
                    toolResult: result
                };
            }

            if (domain === 'storage' && action === 'status') {
                if (!rest) return { ok: false, responseText: 'Usage: /dataapi storage status <scan_id>' };
                const result = await dataapi.storage.scanStatus({ scan_id: rest });
                return {
                    ok: true,
                    responseText: `DataAPI storage.scanStatus(${rest})\n\n${JSON.stringify(result?.data || result, null, 2)}`,
                    tool: { name: 'dataapi.storage.scanStatus', args: { scan_id: rest } },
                    toolResult: result
                };
            }

            // LIVE
            if (domain === 'live' && action === 'iss') {
                const result = await dataapi.live.iss();
                const rows = Array.isArray(result?.data) ? result.data : [];
                return {
                    ok: true,
                    responseText: `DataAPI live.iss\n\nRecords: ${rows.length}`,
                    tool: { name: 'dataapi.live.iss', args: {} },
                    toolResult: result
                };
            }

            if (domain === 'live' && action === 'quakes') {
                const result = await dataapi.live.quakes();
                const rows = Array.isArray(result?.data) ? result.data : [];
                return {
                    ok: true,
                    responseText: `DataAPI live.quakes\n\nRecords: ${rows.length}`,
                    tool: { name: 'dataapi.live.quakes', args: {} },
                    toolResult: result
                };
            }

            return { ok: false, responseText: `Unknown command: /dataapi ${domain} ${action}` };
        } catch (err) {
            if (err instanceof DataApiError) {
                return { ok: false, responseText: `DataAPI error: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}` };
            }
            return { ok: false, responseText: `Tool error: ${err.message}` };
        }
    }

  // Detect models with thinking/reasoning capabilities
  const thinkingModels = [
    'qwen', 'deepseek-r1', 'deepthink', 'o1', 'o3', 'reasoning'
  ];
  const isThinkingModel = thinkingModels.some(pattern => 
    model.toLowerCase().includes(pattern)
  );

  try {
        const toolCommand = await tryHandleToolCommand(message);
        if (toolCommand) {
            // Tool command responses are treated like an assistant reply and stored in history.
            const assistantMessageContent = toolCommand.responseText;

            // V4: Fetch active prompt configuration (still used for storing prompt metadata)
            let activePrompt;
            try {
                activePrompt = await PromptConfig.getActive('default_chat');
                if (!activePrompt) {
                    activePrompt = { systemPrompt: system || 'You are AgentX, a helpful AI assistant.', version: 'default' };
                }
            } catch (_err) {
                activePrompt = { systemPrompt: system || 'You are AgentX, a helpful AI assistant.', version: 'default' };
            }

            // 1. Fetch User Profile
            const userProfile = await getOrCreateProfile(userId);

            // 2. Inject Memory into System Prompt
            let effectiveSystemPrompt = system || activePrompt.systemPrompt;
            if (userProfile.about) {
                effectiveSystemPrompt += `\n\nUser Profile/Memory:\n${userProfile.about}`;
            }
            if (userProfile.preferences?.customInstructions) {
                effectiveSystemPrompt += `\n\nCustom Instructions:\n${userProfile.preferences.customInstructions}`;
            }

            // Save to DB (same behavior as normal chat, but without Ollama call)
            let conversation;
            let assistantMessageId = null;
            try {
                if (conversationId) {
                    conversation = await Conversation.findById(conversationId);
                }
                if (!conversation) {
                    conversation = new Conversation({
                        userId,
                        model,
                        systemPrompt: effectiveSystemPrompt,
                        messages: []
                    });
                }

                conversation.messages.push({ role: 'user', content: message.trim() });

                const assistantMsg = conversation.messages.create({ role: 'assistant', content: assistantMessageContent.trim() });
                assistantMsg.metadata = assistantMsg.metadata || {};
                assistantMsg.metadata.tool = toolCommand.tool || null;
                assistantMsg.metadata.toolResult = toolCommand.toolResult || null;
                conversation.messages.push(assistantMsg);
                assistantMessageId = assistantMsg._id;

                if (conversation.messages.length <= 2) {
                    conversation.title = (message || 'New Conversation').substring(0, 50);
                }

                // mark as no-rag
                conversation.ragUsed = false;
                conversation.ragSources = [];

                conversation.promptConfigId = activePrompt._id;
                conversation.promptName = activePrompt.name;
                conversation.promptVersion = activePrompt.version;

                await conversation.save();
            } catch (err) {
                logger.error('Failed to save tool conversation', { error: err.message, stack: err.stack });
            }

            return res.json({
                status: 'success',
                data: {
                    response: assistantMessageContent,
                    conversationId: conversation ? conversation._id : null,
                    assistantMessageId,
                    tool: toolCommand.tool || null,
                    toolOk: toolCommand.ok === true
                }
            });
        }

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
        options: sanitizeOptions(options),
        streamEnabled: false
    });

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
    
    // Log warnings if any
    if (warning) {
      logger.warn('Response extraction warning', { model, warning });
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

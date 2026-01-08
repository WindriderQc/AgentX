const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const { getOrCreateProfile } = require('../helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget } = require('../utils');
const { tryHandleToolCommand } = require('./toolService');
const { executeTool, parseToolCalls } = require('./toolExecutor');
const { routeRequest, getTargetForModel } = require('./modelRouter');
const { calculateMessageCost, calculateConversationCost } = require('./costCalculator');
const { getCompressionService } = require('./ragCompression');
const logger = require('../../config/logger');
const fetch = require('node-fetch');

// Helper to detect thinking models
const isThinkingModel = (model) => {
    if (!model) return false;
    const thinkingModels = ['qwen', 'deepseek-r1', 'deepthink', 'o1', 'o3', 'reasoning'];
    return thinkingModels.some(pattern => model.toLowerCase().includes(pattern));
};

// Helper to get active prompt
// Week 4: Now supports workspace-scoped prompts
const getActivePrompt = async (system, personaName = 'default_chat', workspaceId = null) => {
    try {
        // Week 4: Pass workspaceId to getActive for workspace-scoped prompts
        const activePrompt = await PromptConfig.getActive(personaName, workspaceId);
        if (activePrompt) return activePrompt;

        // If specific persona requested but not found, try default
        if (personaName !== 'default_chat') {
            const defaultPrompt = await PromptConfig.getActive('default_chat', workspaceId);
            if (defaultPrompt) return defaultPrompt;
        }
    } catch (err) {
        logger.warn('Failed to fetch active prompt, falling back to default', { error: err.message });
    }

    return {
        systemPrompt: system || 'You are AgentX, a helpful AI assistant.',
        version: 'default',
        name: 'default_chat', // Fallback name
        _id: null // No ID for fallback
    };
};

// Helper to build effective system prompt
const buildSystemPrompt = (basePrompt, userProfile, ragContext) => {
    let effectiveSystemPrompt = basePrompt;

    if (ragContext) {
        effectiveSystemPrompt += `\n\n=== RETRIEVED CONTEXT ===\nYou have access to the following retrieved context from the user's files. \nCRITICAL INSTRUCTION: The user's question is likely about the data contained in this context. \n- If the context contains a list of "Available Ingested Documents", and the user asks what files are ingested, LIST THEM.\n- If the context contains JSON or structured data, READ IT CAREFULLY to find the specific value requested (e.g., "totalFiles", counts, names).\n- Answer the question DIRECTLY using the data found.\n- Cite the source file name.\n\n${ragContext}\n\n=== END CONTEXT ===`;
    }

    if (userProfile.about) {
        effectiveSystemPrompt += `\n\nUser Profile/Memory:\n${userProfile.about}`;
    }
    if (userProfile.preferences?.customInstructions) {
        effectiveSystemPrompt += `\n\nCustom Instructions:\n${userProfile.preferences.customInstructions}`;
    }

    return effectiveSystemPrompt;
};

// Core Chat Service
const handleChatRequest = async ({
    userId,
    model,
    message,
    messages = [],
    system,
    options = {},
    persona,
    conversationId,
    useRag,
    ragTopK,
    ragFilters,
    target,
    ragStore,
    autoRoute = false,  // Enable smart model routing
    taskType = null,    // Override task classification
    workspaceId = null  // Week 4: Workspace context
}) => {
    const personaName = persona || options.persona || 'default_chat';

    // 0. Smart Model Routing (if enabled)
    let effectiveModel = model;
    let effectiveTarget = target;
    let routingInfo = null;

    if (autoRoute || taskType) {
        routingInfo = await routeRequest(message, {
            autoRoute,
            taskType,
            preferredModel: model && model !== 'auto' ? model : null
        });
        
        // Always use routing result when autoRoute is enabled
        effectiveModel = routingInfo.model;
        effectiveTarget = routingInfo.target;
        
        if (routingInfo.routed) {
            logger.info('Request routed', {
                taskType: routingInfo.taskType,
                model: routingInfo.model,
                target: routingInfo.target
            });
        }
    } else if (!effectiveTarget && effectiveModel) {
        // No auto-route, but resolve target based on model
        effectiveTarget = getTargetForModel(effectiveModel);
    }

    // 1. Check for Tool Commands
    const toolCommand = await tryHandleToolCommand(message);
    if (toolCommand) {
        const activePrompt = await getActivePrompt(system, personaName, workspaceId);
        const userProfile = await getOrCreateProfile(userId);
        const effectiveSystemPrompt = buildSystemPrompt(activePrompt.systemPrompt, userProfile, null);

        let conversation;
        let assistantMessageId = null;

        try {
            if (conversationId) conversation = await Conversation.findById(conversationId);
            if (!conversation) {
                conversation = new Conversation({
                    userId,
                    workspaceId,  // Week 4: Multi-tenancy
                    model: effectiveModel,
                    systemPrompt: effectiveSystemPrompt,
                    messages: []
                });
            }

            conversation.messages.push({ role: 'user', content: message.trim() });

            const assistantMsg = conversation.messages.create({
                role: 'assistant',
                content: toolCommand.responseText.trim()
            });

            assistantMsg.metadata = {
                tool: toolCommand.tool || null,
                toolResult: toolCommand.toolResult || null
            };

            conversation.messages.push(assistantMsg);
            assistantMessageId = assistantMsg._id;

            if (conversation.messages.length <= 2) {
                conversation.title = (message || 'New Conversation').substring(0, 50);
            }

            // Tool-command conversations shouldn't overwrite previously recorded RAG flags.
            conversation.promptConfigId = activePrompt._id;
            conversation.promptName = activePrompt.name;
            conversation.promptVersion = activePrompt.version;

            await conversation.save();
        } catch (err) {
            logger.error('Failed to save tool conversation', { error: err.message });
        }

        return {
            response: toolCommand.responseText,
            conversationId: conversation ? conversation._id : null,
            assistantMessageId,
            tool: toolCommand.tool || null,
            toolOk: toolCommand.ok === true
        };
    }

    // 2. Standard Chat Flow
    const activePrompt = await getActivePrompt(system, personaName, workspaceId);
    const userProfile = await getOrCreateProfile(userId);

    // RAG Logic
    let ragUsed = false;
    let ragSources = [];
    let ragContext = null;

    if (useRag === true && message && ragStore) {
        try {
            const ollamaHost = resolveTarget(effectiveTarget);
            
            // 1. Advanced RAG Search (with optional expansion, re-ranking, hybrid search)
            const searchResults = await ragStore.searchSimilarChunks(message, {
                topK: ragTopK || 5,
                minScore: 0.25, // Lowered threshold to ensure relevant context is captured
                filters: ragFilters,
                ollamaHost,
                expandQuery: options?.ragExpand === true, // Enable query expansion if requested
                rerankResults: options?.ragRerank === true, // Enable re-ranking if requested
                hybridSearch: options?.ragHybrid === true // Enable hybrid search if requested
            });

            // Contextual Compression
            let processedChunks = searchResults;
            if (options?.ragCompress === true && searchResults.length > 0) {
                try {
                    const compressionService = getCompressionService();
                    processedChunks = await compressionService.compressChunks(
                        message,
                        searchResults,
                        { 
                            compressionModel: process.env.COMPRESSION_MODEL || 'gemma2:2b',
                            minRelevanceScore: parseFloat(process.env.COMPRESSION_MIN_RELEVANCE) || 0.6,
                            maxSentencesPerChunk: parseInt(process.env.COMPRESSION_MAX_SENTENCES) || 5
                        }
                    );
                } catch (compErr) {
                    logger.error('RAG Compression failed, using original chunks', { error: compErr.message });
                    processedChunks = searchResults;
                }
            }

            if (processedChunks.length > 0) {
                ragUsed = true;
                ragContext = '\n\n=== RETRIEVED CONTEXT ===\n';
                ragContext += 'When using information from these sources, cite them inline with [1], [2], etc.\n\n';
                processedChunks.forEach((result, idx) => {
                    const textToUse = result.compressedText !== undefined ? result.compressedText : result.text;
                    ragContext += `\n[Source ${idx + 1}: ${result.metadata.title}]\n${textToUse}\n`;
                    ragSources.push({
                        text: result.text.substring(0, 200),
                        score: result.score,
                        source: result.metadata.source,
                        title: result.metadata.title,
                        documentId: result.metadata.documentId,
                        wasCompressed: result.wasCompressed || false,
                        compressionRatio: result.compressionRatio || 0
                    });
                });
                ragContext += '\n=== END CONTEXT ===\n';
            }

            // 2. Check for "List Files" Intent
            // If the user asks about what files are available, we inject the document list.
            const listFilesRegex = /list.*files|what.*files.*ingested|show.*documents|which.*files|what.*do.*you.*have/i;
            if (listFilesRegex.test(message)) {
                logger.info('Detected file listing intent');
                const docs = await ragStore.listDocuments();
                if (docs.length > 0) {
                    ragUsed = true;
                    const docList = docs.map(d => `- ${d.title} (Source: ${d.source})`).join('\n');
                    const docContext = `\n\n=== Available Ingested Documents ===\nThe following files are currently ingested in the RAG system:\n${docList}\n=== End Document List ===\n`;
                    
                    // Prepend to ensure visibility
                    if (ragContext) {
                        ragContext = docContext + ragContext;
                    } else {
                        ragContext = docContext;
                    }
                    logger.info('Injected document list', { count: docs.length });
                }
            }

        } catch (err) {
            logger.error('RAG retrieval error', { error: err.message });
        }
    }

    const effectiveSystemPrompt = buildSystemPrompt(activePrompt.systemPrompt, userProfile, ragContext);

    // Prepare messages
    const formattedMessages = [
        { role: 'system', content: effectiveSystemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    // Check if model is n8n LLM source
    let assistantMessageContent, thinking, warning, stats;
    try {
        const N8nLLMSource = require('../../models/N8nLLMSource');
        const n8nModel = await N8nLLMSource.findOne({ name: effectiveModel, isActive: true });

        if (n8nModel) {
            logger.info('Using n8n LLM source', { model: effectiveModel, provider: n8nModel.provider });

            const n8nLLMProvider = require('./n8nLLMProvider');
            const n8nResponse = await n8nLLMProvider.chat(n8nModel.webhookUrl, formattedMessages, {
                model: effectiveModel,
                temperature: options?.temperature,
                maxTokens: options?.num_predict || n8nModel.capabilities.maxContext,
                conversationId,
                userId
            });

            assistantMessageContent = n8nResponse.content;
            thinking = null;
            warning = null;
            stats = {
                total_duration: n8nResponse._metadata.latency * 1000000, // Convert ms to ns
                eval_count: n8nResponse.usage?.outputTokens || 0,
                prompt_eval_count: n8nResponse.usage?.inputTokens || 0
            };

            // Record usage
            await n8nModel.recordUsage();

        } else {
            // Fallback to Ollama
            const ollamaPayload = buildOllamaPayload({
                model: effectiveModel,
                messages: formattedMessages,
                options: sanitizeOptions(options),
                streamEnabled: false
            });

            // Call Ollama
            const url = `${resolveTarget(effectiveTarget)}/api/chat`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120000);

            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(ollamaPayload),
                    signal: controller.signal
                });
                if (!response.ok) throw new Error(`Ollama request failed: ${response.statusText}`);
            } catch (err) {
                if (err.name === 'AbortError') {
                    throw new Error('Ollama request timed out (2m limit).');
                }
                throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
            } finally {
                clearTimeout(timeout);
            }

            const data = await response.json();
            const extracted = extractResponse(data, model);
            assistantMessageContent = extracted.content;
            thinking = extracted.thinking;
            warning = extracted.warning;
            stats = extracted.stats;

            if (warning) logger.warn('Response extraction warning', { model, warning });
        }
    } catch (err) {
        logger.error('Model request failed', { model: effectiveModel, error: err.message });
        throw err;
    }

    // 3. Tool Execution Loop (Recursive potential, but limited to 1 turn for now)
    let finalContent = assistantMessageContent;
    let toolExecutionResult = null;

    // Check if assistant wants to call a tool
    const toolCall = parseToolCalls(assistantMessageContent);
    if (toolCall) {
        logger.info('Tool call detected', { tool: toolCall.tool });
        try {
            const result = await executeTool(toolCall.tool, toolCall.params);
            toolExecutionResult = result;

            // Append result to content for the user to see (or hidden?)
            // For now, we append it so the user knows what happened.
            // Ideally, we would feed this back to the model, but for v1 we just report it.
            finalContent += `\n\n--- Tool Execution ---\nTool: ${toolCall.tool}\nStatus: ${result.status}\nResult: ${JSON.stringify(result.data, null, 2)}`;
        } catch (err) {
            finalContent += `\n\n--- Tool Execution Failed ---\nError: ${err.message}`;
        }
    }

    // Save to DB
    let conversation;
    let assistantMessageId = null;

    try {
        if (conversationId) conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            conversation = new Conversation({
                userId,
                workspaceId,  // Week 4: Multi-tenancy
                model: effectiveModel,
                systemPrompt: effectiveSystemPrompt,
                messages: []
            });
        }

        if (message && message.trim()) {
            conversation.messages.push({ role: 'user', content: message.trim() });
        }

        if (assistantMessageContent && assistantMessageContent.trim()) {
            const assistantMsg = conversation.messages.create({
                role: 'assistant',
                content: finalContent.trim()
            });

            if (thinking) {
                assistantMsg.metadata = assistantMsg.metadata || {};
                assistantMsg.metadata.thinking = thinking;
            }

            if (toolExecutionResult) {
                assistantMsg.metadata = assistantMsg.metadata || {};
                assistantMsg.metadata.toolExecution = toolExecutionResult;
            }
            
            // V6: RAG Citation Tracking (2026-01-07)
            if (ragUsed === true && Array.isArray(ragSources) && ragSources.length > 0) {
                assistantMsg.ragSources = ragSources.map(source => ({
                    chunkId: source.documentId, // Store document/chunk ID
                    score: source.score,
                    excerpt: source.text, // Already limited to 200 chars
                    metadata: {
                        filename: source.title,
                        source: source.source,
                        timestamp: new Date()
                    }
                }));
            }

            if (stats) {
                assistantMsg.stats = stats;
                assistantMsg.stats.parameters = options;
                assistantMsg.stats.meta = { model: effectiveModel };

                // V5: Calculate and store cost
                try {
                    const cost = await calculateMessageCost(effectiveModel, stats);
                    assistantMsg.cost = cost;
                    logger.debug('Message cost calculated', {
                        model: effectiveModel,
                        totalCost: cost.totalCost,
                        source: cost.pricingSource?.source
                    });
                } catch (err) {
                    logger.error('Cost calculation failed', {
                        model: effectiveModel,
                        error: err.message
                    });
                }
            }

            conversation.messages.push(assistantMsg);
            assistantMessageId = assistantMsg._id;
        }

        if (conversation.messages.length <= 2) {
            conversation.title = (message || 'New Conversation').substring(0, 50);
        }

        // Persist both the user request (toggle) and the actual retrieval usage.
        // These are conversation-level metrics, so treat them as "ever true" across turns.
        conversation.ragRequested = conversation.ragRequested === true || useRag === true;
        conversation.ragUsed = conversation.ragUsed === true || ragUsed === true;

        // Avoid wiping prior sources when a later turn doesn't use RAG.
        if (ragUsed === true && Array.isArray(ragSources) && ragSources.length > 0) {
            conversation.ragSources = ragSources;
        }
        conversation.promptConfigId = activePrompt._id;
        conversation.promptName = activePrompt.name;
        conversation.promptVersion = activePrompt.version;

        // V5: Update conversation total cost
        try {
            const totalCost = calculateConversationCost(conversation.messages);
            conversation.totalCost = totalCost;
            logger.debug('Conversation cost updated', {
                conversationId: conversation._id,
                totalCost: totalCost.sum,
                messageCount: conversation.messages.length
            });
        } catch (err) {
            logger.error('Conversation cost calculation failed', {
                conversationId: conversation._id,
                error: err.message
            });
        }

        // NEW: Token Usage Tracking (V8)
        try {
            conversation.updateUsage();
            logger.info('Token usage updated', {
              conversationId: conversation._id,
              totalTokens: conversation.usage.totalTokens,
              estimatedCost: conversation.usage.estimatedCost
            });
        } catch (err) {
            logger.error('Token usage update failed', { error: err.message });
        }

        await conversation.save();
    } catch (err) {
        logger.error('Failed to save conversation', { error: err.message });
    }

    return {
        response: finalContent,
        conversationId: conversation?._id || null,
        messageId: assistantMessageId,
        model: effectiveModel,
        target: effectiveTarget,
        routing: routingInfo ? {
            taskType: routingInfo.taskType,
            routed: routingInfo.routed
        } : null,
        stats: stats || null,
        ragUsed,
        ragSources,
        warning: isThinkingModel(effectiveModel) ? 'This model has thinking capabilities. Enable streaming for better response quality.' : undefined
    };
};

// Streaming Chat Service (SSE)
const handleChatRequestStream = async ({
    userId,
    model,
    message,
    messages = [],
    system,
    options = {},
    persona,
    conversationId,
    useRag,
    ragTopK,
    ragFilters,
    target,
    ragStore,
    autoRoute = false,
    taskType = null,
    workspaceId = null,  // Week 4: Workspace context
    onToken,
    onThinking,
    onComplete,
    onError
}) => {
    const personaName = persona || options.persona || 'default_chat';

    try {
        // 0. Smart Model Routing (if enabled)
        let effectiveModel = model;
        let effectiveTarget = target;
        let routingInfo = null;

        if (autoRoute || taskType) {
            routingInfo = await routeRequest(message, {
                autoRoute,
                taskType,
                preferredModel: model && model !== 'auto' ? model : null
            });

            effectiveModel = routingInfo.model;
            effectiveTarget = routingInfo.target;

            if (routingInfo.routed) {
                logger.info('Request routed', {
                    taskType: routingInfo.taskType,
                    model: routingInfo.model,
                    target: routingInfo.target
                });
            }
        } else if (!effectiveTarget && effectiveModel) {
            effectiveTarget = getTargetForModel(effectiveModel);
        }

        // 1. Check for Tool Commands (no streaming for tools)
        const toolCommand = await tryHandleToolCommand(message);
        if (toolCommand) {
            onComplete({
                response: toolCommand.responseText,
                tool: toolCommand.tool || null,
                toolOk: toolCommand.ok === true
            });
            return;
        }

        // 2. Standard Chat Flow with Streaming
        const activePrompt = await getActivePrompt(system, personaName, workspaceId);
        const userProfile = await getOrCreateProfile(userId);

        // RAG Logic
        let ragUsed = false;
        let ragSources = [];
        let ragContext = null;

        if (useRag === true && message && ragStore) {
            try {
                const ollamaHost = resolveTarget(effectiveTarget);

                const searchResults = await ragStore.searchSimilarChunks(message, {
                    topK: ragTopK || 5,
                    minScore: 0.25,
                    filters: ragFilters,
                    ollamaHost,
                    expandQuery: options?.ragExpand === true, // Enable query expansion if requested
                    rerankResults: options?.ragRerank === true, // Enable re-ranking if requested
                    hybridSearch: options?.ragHybrid === true // Enable hybrid search if requested
                });

                // Contextual Compression
                let processedChunks = searchResults;
                if (options?.ragCompress === true && searchResults.length > 0) {
                    try {
                        const compressionService = getCompressionService();
                        processedChunks = await compressionService.compressChunks(
                            message,
                            searchResults,
                            { 
                                compressionModel: process.env.COMPRESSION_MODEL || 'gemma2:2b',
                                minRelevanceScore: parseFloat(process.env.COMPRESSION_MIN_RELEVANCE) || 0.6,
                                maxSentencesPerChunk: parseInt(process.env.COMPRESSION_MAX_SENTENCES) || 5
                            }
                        );
                    } catch (compErr) {
                        logger.error('RAG Compression failed, using original chunks', { error: compErr.message });
                        processedChunks = searchResults;
                    }
                }

                if (processedChunks.length > 0) {
                    ragUsed = true;
                    ragContext = '\n\n=== RETRIEVED CONTEXT ===\n';
                    ragContext += 'When using information from these sources, cite them inline with [1], [2], etc.\n\n';
                    processedChunks.forEach((result, idx) => {
                        const textToUse = result.compressedText !== undefined ? result.compressedText : result.text;
                        ragContext += `\n[Source ${idx + 1}: ${result.metadata.title}]\n${textToUse}\n`;
                        ragSources.push({
                            text: result.text.substring(0, 200),
                            score: result.score,
                            source: result.metadata.source,
                            title: result.metadata.title,
                            documentId: result.metadata.documentId,
                            wasCompressed: result.wasCompressed || false,
                            compressionRatio: result.compressionRatio || 0
                        });
                    });
                    ragContext += '\n=== END CONTEXT ===\n';
                }

                const listFilesRegex = /list.*files|what.*files.*ingested|show.*documents|which.*files|what.*do.*you.*have/i;
                if (listFilesRegex.test(message)) {
                    logger.info('Detected file listing intent');
                    const docs = await ragStore.listDocuments();
                    if (docs.length > 0) {
                        ragUsed = true;
                        const docList = docs.map(d => `- ${d.title} (Source: ${d.source})`).join('\n');
                        const docContext = `\n\n=== Available Ingested Documents ===\nThe following files are currently ingested in the RAG system:\n${docList}\n=== End Document List ===\n`;

                        if (ragContext) {
                            ragContext = docContext + ragContext;
                        } else {
                            ragContext = docContext;
                        }
                        logger.info('Injected document list', { count: docs.length });
                    }
                }

            } catch (err) {
                logger.error('RAG retrieval error', { error: err.message });
            }
        }

        const effectiveSystemPrompt = buildSystemPrompt(activePrompt.systemPrompt, userProfile, ragContext);

        // Prepare messages
        const formattedMessages = [
            { role: 'system', content: effectiveSystemPrompt },
            ...messages.map(m => ({ role: m.role, content: m.content }))
        ];

        // Check if model is n8n LLM source
        const N8nLLMSource = require('../../models/N8nLLMSource');
        const n8nModel = await N8nLLMSource.findOne({ name: effectiveModel, isActive: true });

        if (n8nModel) {
            logger.info('Using n8n LLM source (no streaming support yet)', { model: effectiveModel });

            // n8n doesn't support streaming yet, buffer and send at once
            const n8nLLMProvider = require('./n8nLLMProvider');
            const n8nResponse = await n8nLLMProvider.chat(n8nModel.webhookUrl, formattedMessages, {
                model: effectiveModel,
                temperature: options?.temperature,
                maxTokens: options?.num_predict || n8nModel.capabilities.maxContext,
                conversationId,
                userId
            });

            // Send complete response as single token
            onToken(n8nResponse.content);

            const stats = {
                total_duration: n8nResponse._metadata.latency * 1000000,
                eval_count: n8nResponse.usage?.outputTokens || 0,
                prompt_eval_count: n8nResponse.usage?.inputTokens || 0
            };

            await n8nModel.recordUsage();

            onComplete({
                response: n8nResponse.content,
                conversationId: conversationId || null,
                model: effectiveModel,
                target: effectiveTarget,
                stats,
                ragUsed,
                ragSources
            });

        } else {
            // Ollama Streaming
            const ollamaPayload = buildOllamaPayload({
                model: effectiveModel,
                messages: formattedMessages,
                options: sanitizeOptions(options),
                streamEnabled: true
            });

            const url = `${resolveTarget(effectiveTarget)}/api/chat`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120000);

            let response;
            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(ollamaPayload),
                    signal: controller.signal
                });
                if (!response.ok) throw new Error(`Ollama request failed: ${response.statusText}`);
            } catch (err) {
                clearTimeout(timeout);
                if (err.name === 'AbortError') {
                    throw new Error('Ollama request timed out (2m limit).');
                }
                throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
            } finally {
                clearTimeout(timeout);
            }

            // Parse NDJSON stream
            let fullContent = '';
            let thinkingContent = '';
            let stats = {};

            const stream = response.body;
            const reader = stream.getReader();
            const decoder = new TextDecoder();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n').filter(line => line.trim());

                    for (const line of lines) {
                        try {
                            const data = JSON.parse(line);

                            // Handle thinking model content
                            if (data.message?.thinking) {
                                thinkingContent += data.message.thinking;
                                onThinking(data.message.thinking);
                            }

                            // Handle regular content
                            if (data.message?.content) {
                                fullContent += data.message.content;
                                onToken(data.message.content);
                            }

                            // Capture stats on final message
                            if (data.done) {
                                stats = {
                                    total_duration: data.total_duration || 0,
                                    eval_count: data.eval_count || 0,
                                    prompt_eval_count: data.prompt_eval_count || 0
                                };
                            }
                        } catch (parseErr) {
                            logger.warn('Failed to parse streaming chunk', { error: parseErr.message });
                        }
                    }
                }
            } catch (streamErr) {
                logger.error('Stream reading error', { error: streamErr.message });
                throw streamErr;
            }

            // Save to DB (same as non-streaming)
            let conversation;
            let assistantMessageId = null;

            try {
                if (conversationId) conversation = await Conversation.findById(conversationId);
                if (!conversation) {
                    conversation = new Conversation({
                        userId,
                        workspaceId,  // Week 4: Multi-tenancy
                        model: effectiveModel,
                        systemPrompt: effectiveSystemPrompt,
                        messages: []
                    });
                }

                if (message && message.trim()) {
                    conversation.messages.push({ role: 'user', content: message.trim() });
                }

                if (fullContent && fullContent.trim()) {
                    const assistantMsg = conversation.messages.create({
                        role: 'assistant',
                        content: fullContent.trim()
                    });

                    if (thinkingContent) {
                        assistantMsg.metadata = assistantMsg.metadata || {};
                        assistantMsg.metadata.thinking = thinkingContent;
                    }
                    
                    // V6: RAG Citation Tracking (2026-01-07)
                    if (ragUsed === true && Array.isArray(ragSources) && ragSources.length > 0) {
                        assistantMsg.ragSources = ragSources.map(source => ({
                            chunkId: source.documentId,
                            score: source.score,
                            excerpt: source.text,
                            metadata: {
                                filename: source.title,
                                source: source.source,
                                timestamp: new Date()
                            }
                        }));
                    }

                    if (stats) {
                        assistantMsg.stats = stats;
                        assistantMsg.stats.parameters = options;
                        assistantMsg.stats.meta = { model: effectiveModel };

                        try {
                            const cost = await calculateMessageCost(effectiveModel, stats);
                            assistantMsg.cost = cost;
                        } catch (err) {
                            logger.error('Cost calculation failed', { error: err.message });
                        }
                    }

                    conversation.messages.push(assistantMsg);
                    assistantMessageId = assistantMsg._id;
                }

                if (conversation.messages.length <= 2) {
                    conversation.title = (message || 'New Conversation').substring(0, 50);
                }

                conversation.ragRequested = conversation.ragRequested === true || useRag === true;
                conversation.ragUsed = conversation.ragUsed === true || ragUsed === true;

                if (ragUsed === true && Array.isArray(ragSources) && ragSources.length > 0) {
                    conversation.ragSources = ragSources;
                }
                conversation.promptConfigId = activePrompt._id;
                conversation.promptName = activePrompt.name;
                conversation.promptVersion = activePrompt.version;

                try {
                    const totalCost = calculateConversationCost(conversation.messages);
                    conversation.totalCost = totalCost;
                } catch (err) {
                    logger.error('Conversation cost calculation failed', { error: err.message });
                }

                // NEW: Token Usage Tracking (V8)
                try {
                    conversation.updateUsage();
                    logger.info('Token usage updated', {
                      conversationId: conversation._id,
                      totalTokens: conversation.usage.totalTokens,
                      estimatedCost: conversation.usage.estimatedCost
                    });
                } catch (err) {
                    logger.error('Token usage update failed', { error: err.message });
                }

                await conversation.save();
            } catch (err) {
                logger.error('Failed to save conversation', { error: err.message });
            }

            onComplete({
                response: fullContent,
                conversationId: conversation?._id || null,
                messageId: assistantMessageId,
                model: effectiveModel,
                target: effectiveTarget,
                routing: routingInfo ? {
                    taskType: routingInfo.taskType,
                    routed: routingInfo.routed
                } : null,
                stats: stats || null,
                ragUsed,
                ragSources,
                thinking: thinkingContent || null,
                warning: isThinkingModel(effectiveModel) ? 'Streaming enabled for thinking model.' : undefined
            });
        }

    } catch (err) {
        logger.error('Streaming chat error', { error: err.message, stack: err.stack });
        onError(err);
    }
};

module.exports = { handleChatRequest, handleChatRequestStream };

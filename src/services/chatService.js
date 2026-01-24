const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const AgentX = require('../../models/AgentX');
const { getOrCreateProfile } = require('../helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget } = require('../utils');
const { tryHandleToolCommand } = require('./toolService');
const { executeTool, parseToolCalls } = require('./toolExecutor');
const { routeRequest, getTargetForModel } = require('./modelRouter');
const { calculateMessageCost, calculateConversationCost } = require('./costCalculator');
const { getCompressionService } = require('./ragCompression');
const {
    buildAgentSystemPrompt,
    getAgentToolDefinitions,
    executeN8nTool,
    processToolCalls: processAgentToolCalls
} = require('./agentService');
const logger = require('../../config/logger');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

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
    workspaceId = null, // Week 4: Workspace context
    agentId = null      // AgentX: Unified agent context
}) => {
    let personaName = persona || options.persona || 'default_chat';

    // 0a. Load AgentX context if provided
    let agent = null;
    let agentTools = [];

    if (agentId) {
        try {
            agent = await AgentX.findById(agentId)
                .populate('promptConfigId', 'name systemPrompt version isActive description');

            if (agent) {
                // Override settings from agent
                if (!model || model === 'auto') {
                    model = agent.defaultModel;
                }
                if (agent.promptConfigId?.name) {
                    personaName = agent.promptConfigId.name;
                }
                // Get N8N tool definitions for this agent
                agentTools = getAgentToolDefinitions(agent);

                // Apply agent capabilities
                if (agent.capabilities) {
                    if (typeof useRag === 'undefined' && agent.capabilities.supportsRag !== undefined) {
                        useRag = agent.capabilities.supportsRag;
                    }
                    if (agent.capabilities.autoRoute) {
                        autoRoute = true;
                    }
                }

                logger.info('AgentX context loaded', {
                    agentId: agent._id,
                    agentName: agent.name,
                    model: agent.defaultModel,
                    toolCount: agentTools.length
                });
            }
        } catch (err) {
            logger.warn('Failed to load AgentX context', { agentId, error: err.message });
        }
    }

    // 0b. Smart Model Routing (if enabled)
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

    // 1.5. Image Generation Flow
    if (personaName === 'visual_llm') {
        try {
            // Use OLLAMA_HOST_2 for image generation if available
            const imageTarget = process.env.OLLAMA_HOST_2 || resolveTarget(effectiveTarget);
            // Ensure generated directory exists
            const generatedDir = path.join(__dirname, '../../public/generated');
            await fs.mkdir(generatedDir, { recursive: true });

            let data;
            if (effectiveModel === 'x/flux2-klein:9b' || effectiveModel === 'flux2-klein:9b') {
                // Use /api/chat for this model
                const url = `${imageTarget}/api/chat`;
                const payload = {
                    model: effectiveModel,
                    messages: [
                        { role: 'user', content: message }
                    ]
                };
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 120000);
                let response;
                try {
                    response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                    if (!response.ok) throw new Error(`Ollama chat request failed: ${response.statusText}`);
                } catch (err) {
                    if (err.name === 'AbortError') {
                        throw new Error('Ollama chat request timed out (2m limit).');
                    }
                    throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
                } finally {
                    clearTimeout(timeout);
                }
                data = await response.json();
                if (!data.message || !data.message.content) {
                    throw new Error('No image data received from Ollama chat');
                }
                // The image is expected to be in message.content as base64
                data.response = data.message.content;
            } else {
                // Default: use /api/generate
                const url = `${imageTarget}/api/generate`;
                const payload = {
                    model: effectiveModel,
                    prompt: message,
                    stream: false
                };
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 120000);
                let response;
                try {
                    response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                    if (!response.ok) throw new Error(`Ollama generate request failed: ${response.statusText}`);
                } catch (err) {
                    if (err.name === 'AbortError') {
                        throw new Error('Ollama generate request timed out (2m limit).');
                    }
                    throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
                } finally {
                    clearTimeout(timeout);
                }
                data = await response.json();
            }

            if (!data.response) {
                throw new Error('No image data received from Ollama');
            }

            // Decode base64 and save image
            const imageBuffer = Buffer.from(data.response, 'base64');
            const filename = `image_${Date.now()}.png`;
            const filepath = path.join(generatedDir, filename);
            await fs.writeFile(filepath, imageBuffer);

            // Save to conversation if conversationId provided
            let conversation = null;
            let assistantMessageId = null;
            if (conversationId) {
                try {
                    conversation = await Conversation.findById(conversationId);
                    if (conversation) {
                        conversation.messages.push({ role: 'user', content: message });
                        const assistantMsg = conversation.messages.create({
                            role: 'assistant',
                            content: 'Image generated successfully.',
                            metadata: { imageUrl: `/generated/${filename}` }
                        });
                        conversation.messages.push(assistantMsg);
                        assistantMessageId = assistantMsg._id;
                        await conversation.save();
                    }
                } catch (err) {
                    logger.error('Failed to save image generation conversation', { error: err.message });
                }
            }

            return {
                response: 'Image generated successfully.',
                attachments: [{ type: 'image', url: `/generated/${filename}` }],
                conversationId: conversation ? conversation._id : null,
                assistantMessageId
            };
        } catch (err) {
            logger.error('Image generation failed', { error: err.message });
            throw new Error(`Image generation failed: ${err.message}`);
        }
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
                            maxSentencesPerChunk: parseInt(process.env.COMPRESSION_MAX_SENTENCES, 10) || 5
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
                streamEnabled: false,
                tools: agentTools  // AgentX: Pass N8N tools for function calling
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

            // AgentX: Handle tool calls from Ollama response
            if (data.message?.tool_calls && data.message.tool_calls.length > 0 && agent) {
                logger.info('Ollama returned tool calls', {
                    count: data.message.tool_calls.length,
                    tools: data.message.tool_calls.map(tc => tc.function?.name)
                });

                // Execute N8N tools
                const toolResults = await processAgentToolCalls(
                    data.message.tool_calls,
                    agent,
                    { conversationId, userId, workspaceId }
                );

                // Add tool results to messages and make another call
                const toolResultMessages = toolResults.map(result => ({
                    role: 'tool',
                    content: JSON.stringify(result.success ? result.result : { error: result.error }),
                    name: result.function_name
                }));

                // Make follow-up call with tool results
                const followUpMessages = [
                    ...formattedMessages,
                    data.message,  // Include the assistant's tool call message
                    ...toolResultMessages
                ];

                const followUpPayload = buildOllamaPayload({
                    model: effectiveModel,
                    messages: followUpMessages,
                    options: sanitizeOptions(options),
                    streamEnabled: false
                });

                // Add timeout protection for follow-up request (same as initial request)
                const followUpController = new AbortController();
                const followUpTimeout = setTimeout(() => followUpController.abort(), 120000);

                let followUpResponse;
                try {
                    followUpResponse = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(followUpPayload),
                        signal: followUpController.signal
                    });
                    if (!followUpResponse.ok) {
                        throw new Error(`Ollama follow-up request failed: ${followUpResponse.statusText}`);
                    }
                } catch (followUpErr) {
                    if (followUpErr.name === 'AbortError') {
                        throw new Error('Ollama follow-up request timed out (2m limit).');
                    }
                    throw followUpErr;
                } finally {
                    clearTimeout(followUpTimeout);
                }

                const followUpData = await followUpResponse.json();
                const extracted = extractResponse(followUpData, effectiveModel);
                assistantMessageContent = extracted.content;
                thinking = extracted.thinking;
                warning = extracted.warning;
                stats = extracted.stats;
            } else {
                const extracted = extractResponse(data, model);
                assistantMessageContent = extracted.content;
                thinking = extracted.thinking;
                warning = extracted.warning;
                stats = extracted.stats;
            }

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

        // AgentX: Record agent association
        if (agent) {
            conversation.agentId = agent._id;
            conversation.agentName = agent.name;
        }

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
    abortSignal,
    onToken,
    onThinking,
    onComplete,
    onError
}) => {
    const personaName = persona || options.persona || 'default_chat';

    logger.info('DEBUG_STREAM: handleChatRequestStream called', { 
        workspaceId, 
        userId,
        conversationId
    });

    try {
        if (abortSignal?.aborted) {
            return;
        }
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
                                maxSentencesPerChunk: parseInt(process.env.COMPRESSION_MAX_SENTENCES, 10) || 5
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
            if (!abortSignal?.aborted) {
                onToken(n8nResponse.content);
            }

            const stats = {
                total_duration: n8nResponse._metadata.latency * 1000000,
                eval_count: n8nResponse.usage?.outputTokens || 0,
                prompt_eval_count: n8nResponse.usage?.inputTokens || 0
            };

            await n8nModel.recordUsage();

            if (!abortSignal?.aborted) {
                onComplete({
                    response: n8nResponse.content,
                    conversationId: conversationId || null,
                    model: effectiveModel,
                    target: effectiveTarget,
                    stats,
                    ragUsed,
                    ragSources
                });
            }

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
            const handleAbort = () => controller.abort();
            if (abortSignal) {
                abortSignal.addEventListener('abort', handleAbort);
            }
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
                    if (abortSignal?.aborted) {
                        return;
                    }
                    throw new Error('Ollama request timed out (2m limit).');
                }
                throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
            } finally {
                clearTimeout(timeout);
                if (abortSignal) {
                    abortSignal.removeEventListener('abort', handleAbort);
                }
            }

            // Parse NDJSON stream
            let fullContent = '';
            let thinkingContent = '';
            let stats = {};

            // const stream = response.body;
            // const reader = stream.getReader();
            // const decoder = new TextDecoder();

            const decoder = new TextDecoder();

            try {
                // Universal stream iterator (works with both Node streams and Web streams)
                for await (const chunk of response.body) {
                    if (abortSignal?.aborted) {
                        return;
                    }
                    
                    // Handle Buffer (Node) or Uint8Array (Web)
                    const text = decoder.decode(chunk, { stream: true });
                    const lines = text.split('\n').filter(line => line.trim());

                    for (const line of lines) {
                        try {
                            const data = JSON.parse(line);

                            // Handle thinking model content
                            if (data.message?.thinking) {
                                thinkingContent += data.message.thinking;
                                if (!abortSignal?.aborted) {
                                    onThinking(data.message.thinking);
                                }
                            }

                            // Handle regular content
                            if (data.message?.content) {
                                fullContent += data.message.content;
                                if (!abortSignal?.aborted) {
                                    onToken(data.message.content);
                                }
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
                conversation.promptVersion = (activePrompt.version == null || Number.isNaN(Number(activePrompt.version))) ? 1 : Number(activePrompt.version);

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

            if (!abortSignal?.aborted) {
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
        }

    } catch (err) {
        if (!abortSignal?.aborted) {
            logger.error('Streaming chat error', { error: err.message, stack: err.stack });
            onError(err);
        }
    }
};

module.exports = { handleChatRequest, handleChatRequestStream };

const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');
const { getOrCreateProfile } = require('../helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget } = require('../utils');
const { tryHandleToolCommand } = require('./toolService');
const { executeTool, parseToolCalls } = require('./toolExecutor');
const { routeRequest, getTargetForModel } = require('./modelRouter');
const { calculateMessageCost, calculateConversationCost } = require('./costCalculator');
const logger = require('../../config/logger');
const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));

// Helper to detect thinking models
const isThinkingModel = (model) => {
    if (!model) return false;
    const thinkingModels = ['qwen', 'deepseek-r1', 'deepthink', 'o1', 'o3', 'reasoning'];
    return thinkingModels.some(pattern => model.toLowerCase().includes(pattern));
};

// Helper to get active prompt
const getActivePrompt = async (system, personaName = 'default_chat') => {
    try {
        const activePrompt = await PromptConfig.getActive(personaName);
        if (activePrompt) return activePrompt;

        // If specific persona requested but not found, try default
        if (personaName !== 'default_chat') {
            const defaultPrompt = await PromptConfig.getActive('default_chat');
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
    conversationId,
    useRag,
    ragTopK,
    ragFilters,
    target,
    ragStore,
    autoRoute = false,  // Enable smart model routing
    taskType = null     // Override task classification
}) => {
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
        const activePrompt = await getActivePrompt(system);
        const userProfile = await getOrCreateProfile(userId);
        const effectiveSystemPrompt = buildSystemPrompt(activePrompt.systemPrompt, userProfile, null);

        let conversation;
        let assistantMessageId = null;

        try {
            if (conversationId) conversation = await Conversation.findById(conversationId);
            if (!conversation) {
                conversation = new Conversation({
                    userId,
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

            conversation.ragUsed = false;
            conversation.ragSources = [];
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
    const persona = options.persona || 'default_chat';
    const activePrompt = await getActivePrompt(system, persona);
    const userProfile = await getOrCreateProfile(userId);

    // RAG Logic
    let ragUsed = false;
    let ragSources = [];
    let ragContext = null;

    if (useRag === true && message && ragStore) {
        try {
            const ollamaHost = resolveTarget(effectiveTarget);
            
            // 1. Standard Semantic Search
            const searchResults = await ragStore.searchSimilarChunks(message, {
                topK: ragTopK || 5,
                minScore: 0.25, // Lowered threshold to ensure relevant context is captured
                filters: ragFilters,
                ollamaHost
            });

            if (searchResults.length > 0) {
                ragUsed = true;
                ragContext = '\n\n=== Retrieved Context ===\n';
                searchResults.forEach((result, idx) => {
                    ragContext += `\n[Source ${idx + 1}: ${result.metadata.title}]\n${result.text}\n`;
                    ragSources.push({
                        text: result.text.substring(0, 200),
                        score: result.score,
                        source: result.metadata.source,
                        title: result.metadata.title,
                        documentId: result.metadata.documentId
                    });
                });
                ragContext += '\n=== End Context ===\n';
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

    // Prepare Ollama Payload
    const formattedMessages = [
        { role: 'system', content: effectiveSystemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

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
    const { content: assistantMessageContent, thinking, warning, stats } = extractResponse(data, model);

    if (warning) logger.warn('Response extraction warning', { model, warning });

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

        conversation.ragUsed = ragUsed;
        conversation.ragSources = ragSources;
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

module.exports = { handleChatRequest };

const Conversation = require('../../models/Conversation');
const AgentX = require('../../models/AgentX');
const { getOrCreateProfile } = require('../helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget, resolveModelNumCtx } = require('../utils');
const { tryHandleToolCommand } = require('./toolService');
const { executeTool, parseToolCalls } = require('./toolExecutor');
const { routeRequest, getTargetForModel, recordInference } = require('./modelRouter');
const {
    buildAgentSystemPrompt,
    getAgentToolDefinitions,
    executeN8nTool,
    processToolCalls: processAgentToolCalls
} = require('./agentService');
const logger = require('../../config/logger');
const fetch = require('node-fetch');

// Extracted modules
const { isThinkingModel, getActivePrompt, buildSystemPrompt } = require('./chat/chatPromptHelpers');
const { buildRagContext } = require('./chat/ragContextBuilder');
const { persistConversation, findConversationForUpdate } = require('./chat/conversationPersistence');
const { handleImageGeneration } = require('./chat/imageGeneration');

// Core Chat Service
function resolveRequestedMaxTokens(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

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
    autoRoute = false,
    taskType = null,
    workspaceId = null,
    agentId = null,
    enableWebSearch = false
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
                if (!model || model === 'auto') model = agent.defaultModel;
                if (agent.promptConfigId?.name) personaName = agent.promptConfigId.name;
                agentTools = getAgentToolDefinitions(agent);

                if (agent.capabilities) {
                    if (typeof useRag === 'undefined' && agent.capabilities.supportsRag !== undefined) {
                        useRag = agent.capabilities.supportsRag;
                    }
                    if (agent.capabilities.autoRoute) autoRoute = true;
                }

                logger.info('AgentX context loaded', {
                    agentId: agent._id, agentName: agent.name,
                    model: agent.defaultModel, toolCount: agentTools.length
                });
            }
        } catch (err) {
            logger.warn('Failed to load AgentX context', { agentId, error: err.message });
        }
    }

    // 0b. Smart Model Routing
    let effectiveModel = model;
    let effectiveTarget = target;
    let routingInfo = null;

    if (autoRoute || taskType) {
        routingInfo = await routeRequest(message, {
            autoRoute, taskType,
            preferredModel: model && model !== 'auto' ? model : null
        });
        effectiveModel = routingInfo.model;
        effectiveTarget = routingInfo.target;

        if (routingInfo.routed) {
            logger.info('Request routed', {
                taskType: routingInfo.taskType, model: routingInfo.model, target: routingInfo.target
            });
        }
    } else if (!effectiveTarget && effectiveModel) {
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
            if (conversationId) {
                conversation = await findConversationForUpdate({ conversationId, userId, workspaceId });
            }
            if (!conversation) {
                conversation = new Conversation({
                    userId, workspaceId, model: effectiveModel,
                    systemPrompt: effectiveSystemPrompt, messages: []
                });
            }

            conversation.messages.push({ role: 'user', content: message.trim() });

            const assistantMsg = conversation.messages.create({
                role: 'assistant', content: toolCommand.responseText.trim()
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
            const imageResult = await handleImageGeneration({
                message, effectiveModel, effectiveTarget, conversationId
            });

            // Save to conversation if conversationId provided
            let conversation = null;
            let assistantMessageId = null;
            if (conversationId) {
                try {
                    conversation = await findConversationForUpdate({ conversationId, userId, workspaceId });
                    if (conversation) {
                        conversation.messages.push({ role: 'user', content: message });
                        const assistantMsg = conversation.messages.create({
                            role: 'assistant', content: 'Image generated successfully.',
                            metadata: { imageUrl: imageResult.imageUrl }
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
                response: imageResult.response,
                attachments: imageResult.attachments,
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
        const ragResult = await buildRagContext(message, ragStore, {
            effectiveTarget,
            ragTopK,
            ragFilters,
            ragOptions: options
        });
        ragUsed = ragResult.ragUsed;
        ragSources = ragResult.ragSources;
        ragContext = ragResult.ragContext;
    }

    // Web Search Logic
    let webSearchResults = [];
    let webSearchContext = null;

    if (enableWebSearch && message) {
        try {
            const { searchWeb } = require('./webSearch');
            const searchResult = await searchWeb(message);
            webSearchResults = searchResult.results || [];
            if (searchResult.formatted) {
                webSearchContext = searchResult.formatted;
            }
        } catch (err) {
            logger.warn('Web search failed', { error: err.message });
        }
    }

    const effectiveSystemPrompt = buildSystemPrompt(activePrompt.systemPrompt, userProfile, ragContext);

    const formattedMessages = [
        { role: 'system', content: effectiveSystemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content }))
    ];

    // Inject web search context before the last user message
    if (webSearchContext && formattedMessages.length > 1) {
        formattedMessages.splice(formattedMessages.length - 1, 0, {
            role: 'user',
            content: `Use these web search results as additional context for your analysis:\n\n${webSearchContext}`
        });
    }

    // Model call
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
                maxTokens: resolveRequestedMaxTokens(options?.num_predict),
                conversationId, userId
            });

            assistantMessageContent = n8nResponse.content;
            thinking = null;
            warning = null;
            const inputTokens = n8nResponse.usage?.inputTokens || 0;
            const outputTokens = n8nResponse.usage?.outputTokens || 0;
            stats = {
                usage: {
                    promptTokens: inputTokens,
                    completionTokens: outputTokens,
                    totalTokens: inputTokens + outputTokens
                },
                performance: {
                    totalDuration: n8nResponse._metadata.latency * 1000000
                }
            };
            await n8nModel.recordUsage();

        } else {
            // Resolve per-model num_ctx from registry, aware of target host VRAM
            const sanitized = sanitizeOptions(options) || {};
            if (!sanitized.num_ctx) {
                sanitized.num_ctx = await resolveModelNumCtx(effectiveModel, { targetHost: resolveTarget(effectiveTarget) });
            }

            const ollamaPayload = buildOllamaPayload({
                model: effectiveModel,
                messages: formattedMessages,
                options: sanitized,
                streamEnabled: false,
                tools: agentTools
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
                if (!response.ok) {
                    let errDetail = response.statusText;
                    try { const errBody = await response.json(); errDetail = errBody.error || JSON.stringify(errBody) || errDetail; } catch {}
                    throw new Error(`Ollama request failed: ${errDetail}`);
                }
            } catch (err) {
                if (err.name === 'AbortError') throw new Error('Ollama request timed out (2m limit).');
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

                const toolResults = await processAgentToolCalls(
                    data.message.tool_calls, agent,
                    { conversationId, userId, workspaceId }
                );

                const toolResultMessages = toolResults.map(result => ({
                    role: 'tool',
                    content: JSON.stringify(result.success ? result.result : { error: result.error }),
                    name: result.function_name
                }));

                const followUpMessages = [
                    ...formattedMessages, data.message, ...toolResultMessages
                ];

                const followUpPayload = buildOllamaPayload({
                    model: effectiveModel,
                    messages: followUpMessages,
                    options: sanitized,
                    streamEnabled: false
                });

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
                    if (!followUpResponse.ok) throw new Error(`Ollama follow-up request failed: ${followUpResponse.statusText}`);
                } catch (followUpErr) {
                    if (followUpErr.name === 'AbortError') throw new Error('Ollama follow-up request timed out (2m limit).');
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
                const extracted = extractResponse(data, effectiveModel);
                assistantMessageContent = extracted.content;
                thinking = extracted.thinking;
                warning = extracted.warning;
                stats = extracted.stats;
            }

            if (warning) logger.warn('Response extraction warning', { model, warning });
        }
    } catch (err) {
        logger.error('Model request failed', { model: effectiveModel, error: err.message });
        // Record failed inference before re-throwing
        recordInference({
            host: resolveTarget(effectiveTarget),
            model: effectiveModel,
            caller: 'chat',
            callerDetail: userId ? String(userId) : null,
            taskType: routingInfo?.taskType || null,
            routed: routingInfo?.routed || false,
            status: err.name === 'AbortError' ? 'timeout' : 'error',
            error: err.message
        });
        throw err;
    }

    // Record successful inference (fire-and-forget)
    recordInference({
        host: resolveTarget(effectiveTarget),
        model: effectiveModel,
        caller: 'chat',
        callerDetail: userId ? String(userId) : null,
        taskType: routingInfo?.taskType || null,
        routed: routingInfo?.routed || false,
        tokensIn: stats?.usage?.promptTokens || 0,
        tokensOut: stats?.usage?.completionTokens || 0,
        durationMs: stats?.performance?.totalDuration
            ? Math.round(stats.performance.totalDuration / 1e6) : 0,
        status: 'success'
    });

    // 3. Tool Execution Loop
    let finalContent = assistantMessageContent;
    let toolExecutionResult = null;

    const toolCall = parseToolCalls(assistantMessageContent);
    if (toolCall) {
        logger.info('Tool call detected', { tool: toolCall.tool });
        try {
            const result = await executeTool(toolCall.tool, toolCall.params);
            toolExecutionResult = result;
            finalContent += `\n\n--- Tool Execution ---\nTool: ${toolCall.tool}\nStatus: ${result.status}\nResult: ${JSON.stringify(result.data, null, 2)}`;
        } catch (err) {
            finalContent += `\n\n--- Tool Execution Failed ---\nError: ${err.message}`;
        }
    }

    // Persist conversation
    const { conversation, assistantMessageId } = await persistConversation({
        userId, workspaceId, conversationId, model: effectiveModel,
        effectiveSystemPrompt, message, assistantContent: finalContent,
        activePrompt,
        metadata: { thinking, toolExecution: toolExecutionResult, agent, options, webSearchResults },
        stats, ragUsed, useRag, ragSources
    });

    return {
        response: finalContent,
        conversationId: conversation?._id || null,
        messageId: assistantMessageId,
        model: effectiveModel,
        target: effectiveTarget,
        routing: routingInfo ? { taskType: routingInfo.taskType, routed: routingInfo.routed } : null,
        stats: stats || null,
        ragUsed,
        ragSources,
        webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
        warning: isThinkingModel(effectiveModel) ? 'This model has thinking capabilities. Enable streaming for better response quality.' : undefined
    };
};


// Streaming handler extracted to chatServiceStream.js
const { handleChatRequestStream } = require('./chatServiceStream');

module.exports = { handleChatRequest, handleChatRequestStream };

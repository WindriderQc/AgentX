'use strict';
/**
 * Chat Service — Streaming (SSE) Handler
 *
 * Extracted from chatService.js to keep file size within 600-line limit.
 * Imported and re-exported by chatService.js for API compatibility.
 */

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
const { persistConversation } = require('./chat/conversationPersistence');
const { handleImageGeneration } = require('./chat/imageGeneration');


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
    enableWebSearch = false,
    workspaceId = null,
    abortSignal,
    onWebSearchStart,
    onWebSearchDone,
    onToken,
    onThinking,
    onComplete,
    onError
}) => {
    const personaName = persona || options.persona || 'default_chat';

    logger.info('DEBUG_STREAM: handleChatRequestStream called', {
        workspaceId, userId, conversationId
    });

    try {
        if (abortSignal?.aborted) return;

        // 0. Smart Model Routing
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
                if (onWebSearchStart) onWebSearchStart();
                const { searchWeb } = require('./webSearch');
                const searchResult = await searchWeb(message);
                webSearchResults = searchResult.results || [];
                if (searchResult.formatted) {
                    webSearchContext = searchResult.formatted;
                }
                if (onWebSearchDone) onWebSearchDone(webSearchResults.length);
            } catch (err) {
                logger.warn('Web search failed (streaming)', { error: err.message });
                if (onWebSearchDone) onWebSearchDone(0);
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

        // Check if model is n8n LLM source
        const N8nLLMSource = require('../../models/N8nLLMSource');
        const n8nModel = await N8nLLMSource.findOne({ name: effectiveModel, isActive: true });

        if (n8nModel) {
            logger.info('Using n8n LLM source (no streaming support yet)', { model: effectiveModel });

            const n8nLLMProvider = require('./n8nLLMProvider');
            const n8nResponse = await n8nLLMProvider.chat(n8nModel.webhookUrl, formattedMessages, {
                model: effectiveModel,
                temperature: options?.temperature,
                maxTokens: options?.num_predict || n8nModel.capabilities.maxContext,
                conversationId, userId
            });

            if (!abortSignal?.aborted) onToken(n8nResponse.content);

            const n8nInputTokens = n8nResponse.usage?.inputTokens || 0;
            const n8nOutputTokens = n8nResponse.usage?.outputTokens || 0;
            const stats = {
                usage: {
                    promptTokens: n8nInputTokens,
                    completionTokens: n8nOutputTokens,
                    totalTokens: n8nInputTokens + n8nOutputTokens
                },
                performance: {
                    totalDuration: n8nResponse._metadata.latency * 1000000
                }
            };

            await n8nModel.recordUsage();

            // Persist conversation (was missing for n8n streaming path)
            const { conversation: n8nConv, assistantMessageId: n8nMsgId } = await persistConversation({
                userId, workspaceId, conversationId, model: effectiveModel,
                effectiveSystemPrompt, message, assistantContent: n8nResponse.content,
                activePrompt,
                metadata: { options, webSearchResults },
                stats, ragUsed, useRag, ragSources
            });

            if (!abortSignal?.aborted) {
                onComplete({
                    response: n8nResponse.content,
                    conversationId: n8nConv?._id || conversationId || null,
                    messageId: n8nMsgId,
                    model: effectiveModel, target: effectiveTarget,
                    stats, ragUsed, ragSources,
                    webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined
                });
            }

        } else {
            // Ollama Streaming — resolve per-model num_ctx from registry, aware of target host VRAM
            const streamSanitized = sanitizeOptions(options) || {};
            if (!streamSanitized.num_ctx) {
                streamSanitized.num_ctx = await resolveModelNumCtx(effectiveModel, { targetHost: resolveTarget(effectiveTarget) });
            }

            const ollamaPayload = buildOllamaPayload({
                model: effectiveModel,
                messages: formattedMessages,
                options: streamSanitized,
                streamEnabled: true
            });

            const url = `${resolveTarget(effectiveTarget)}/api/chat`;
            const controller = new AbortController();
            const handleAbort = () => controller.abort();
            if (abortSignal) abortSignal.addEventListener('abort', handleAbort);
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
                    if (abortSignal?.aborted) return;
                    throw new Error('Ollama request timed out (2m limit).');
                }
                throw new Error(`Failed to connect to Ollama at ${url}: ${err.message}`);
            } finally {
                clearTimeout(timeout);
                if (abortSignal) abortSignal.removeEventListener('abort', handleAbort);
            }

            // Parse NDJSON stream
            let fullContent = '';
            let thinkingContent = '';
            let stats = {};

            const decoder = new TextDecoder();

            try {
                for await (const chunk of response.body) {
                    if (abortSignal?.aborted) return;

                    const text = decoder.decode(chunk, { stream: true });
                    const lines = text.split('\n').filter(line => line.trim());

                    for (const line of lines) {
                        try {
                            const data = JSON.parse(line);

                            if (data.message?.thinking) {
                                thinkingContent += data.message.thinking;
                                if (!abortSignal?.aborted) onThinking(data.message.thinking);
                            }

                            if (data.message?.content) {
                                fullContent += data.message.content;
                                if (!abortSignal?.aborted) onToken(data.message.content);
                            }

                            if (data.done) {
                                const evalCount = data.eval_count || 0;
                                const promptEvalCount = data.prompt_eval_count || 0;
                                stats = {
                                    usage: {
                                        promptTokens: promptEvalCount,
                                        completionTokens: evalCount,
                                        totalTokens: promptEvalCount + evalCount
                                    },
                                    performance: {
                                        totalDuration: data.total_duration || 0,
                                        evalDuration: data.eval_duration || 0,
                                        promptEvalDuration: data.prompt_eval_duration || 0,
                                        tokensPerSecond: data.eval_duration > 0
                                            ? Math.round((evalCount / data.eval_duration) * 1e9)
                                            : 0
                                    }
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

            // Record streaming inference (fire-and-forget)
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

            // Persist conversation
            const { conversation, assistantMessageId } = await persistConversation({
                userId, workspaceId, conversationId, model: effectiveModel,
                effectiveSystemPrompt, message, assistantContent: fullContent,
                activePrompt,
                metadata: { thinking: thinkingContent || null, options, webSearchResults },
                stats, ragUsed, useRag, ragSources
            });

            if (!abortSignal?.aborted) {
                onComplete({
                    response: fullContent,
                    conversationId: conversation?._id || null,
                    messageId: assistantMessageId,
                    model: effectiveModel,
                    target: effectiveTarget,
                    routing: routingInfo ? { taskType: routingInfo.taskType, routed: routingInfo.routed } : null,
                    stats: stats || null,
                    ragUsed, ragSources,
                    webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
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


module.exports = { handleChatRequestStream };

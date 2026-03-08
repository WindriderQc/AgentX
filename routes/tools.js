/**
 * Tool Execution Routes
 * Handles N8N workflow execution as LLM tools
 */

const express = require('express');
const router = express.Router();
const AgentX = require('../models/AgentX');
const { optionalAuth } = require('../src/middleware/auth');
const { optionalWorkspaceContext } = require('../src/middleware/workspace');
const { triggerWebhook } = require('../src/utils/n8nWebhook');
const logger = require('../config/logger');
const { validateObjectId } = require('../src/helpers/objectIdValidator');

/**
 * POST /api/tools/n8n-proxy
 * Execute an N8N workflow as an LLM tool call (blocking/synchronous)
 *
 * This endpoint is called when the LLM decides to invoke an N8N tool.
 * It executes the webhook and waits for the response to feed back to the LLM.
 *
 * Body: {
 *   toolId: string,      // The tool ID (without 'n8n_' prefix)
 *   agentId: string,     // The AgentX ID that owns this tool
 *   parameters: object,  // Parameters from the LLM tool call
 *   context?: object     // Optional conversation context
 * }
 */
router.post('/n8n-proxy', optionalAuth, optionalWorkspaceContext, async (req, res) => {
    const startTime = Date.now();
    const { toolId, agentId, parameters, context } = req.body;

    // Validation
    if (!toolId || !agentId) {
        return res.status(400).json({
            status: 'error',
            message: 'toolId and agentId are required'
        });
    }

    try {
        if (!validateObjectId(agentId, res, 'Agent ID')) return;

        // Find the agent
        const agent = await AgentX.findById(agentId);
        if (!agent) {
            return res.status(404).json({
                status: 'error',
                message: 'Agent not found'
            });
        }

        // Find the tool
        const tool = agent.findTool(toolId);
        if (!tool) {
            return res.status(404).json({
                status: 'error',
                message: `Tool "${toolId}" not found on agent "${agent.name}"`
            });
        }

        if (!tool.isActive) {
            return res.status(400).json({
                status: 'error',
                message: `Tool "${toolId}" is currently disabled`
            });
        }

        logger.info('Executing N8N tool', {
            toolId: tool.toolId,
            agentId: agent._id,
            agentName: agent.name
        });

        // Build the payload for N8N
        const payload = {
            toolId: tool.toolId,
            toolName: tool.name,
            agentId: agent._id.toString(),
            agentName: agent.name,
            parameters: parameters || {},
            context: {
                conversationId: context?.conversationId,
                userId: req.user?._id?.toString(),
                workspaceId: req.workspace?._id?.toString(),
                timestamp: new Date().toISOString(),
                ...context
            },
            source: 'agentx-tool-call'
        };

        // Execute the webhook (blocking)
        const result = await triggerWebhook(tool.webhookUrl, payload, {
            timeout: tool.timeout || 30000
        });

        const executionTime = Date.now() - startTime;

        // Record the tool invocation
        await agent.recordToolInvocation();

        if (result.success) {
            logger.info('N8N tool executed successfully', {
                toolId: tool.toolId,
                executionTime
            });

            res.json({
                status: 'success',
                data: {
                    toolId: tool.toolId,
                    toolName: tool.name,
                    result: result.data,
                    executionTime
                }
            });
        } else {
            logger.warn('N8N tool execution failed', {
                toolId: tool.toolId,
                error: result.error,
                executionTime
            });

            res.status(502).json({
                status: 'error',
                message: result.error || 'N8N workflow execution failed',
                data: {
                    toolId: tool.toolId,
                    toolName: tool.name,
                    executionTime
                }
            });
        }
    } catch (err) {
        const executionTime = Date.now() - startTime;
        logger.error('N8N tool proxy error', {
            error: err.message,
            toolId,
            agentId,
            executionTime
        });
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
});

/**
 * POST /api/tools/n8n-proxy/test
 * Test an N8N webhook connection without requiring an agent
 *
 * Body: {
 *   webhookUrl: string,  // The webhook URL to test
 *   timeout?: number     // Optional timeout in ms
 * }
 */
router.post('/n8n-proxy/test', optionalAuth, async (req, res) => {
    const { webhookUrl, timeout } = req.body;

    if (!webhookUrl) {
        return res.status(400).json({
            status: 'error',
            message: 'webhookUrl is required'
        });
    }

    const startTime = Date.now();

    try {
        logger.info('Testing N8N webhook', { webhookUrl });

        const result = await triggerWebhook(webhookUrl, {
            test: true,
            source: 'agentx-test',
            timestamp: new Date().toISOString()
        }, {
            timeout: timeout || 10000
        });

        const executionTime = Date.now() - startTime;

        if (result.success) {
            res.json({
                status: 'success',
                message: 'Webhook connection successful',
                data: {
                    response: result.data,
                    executionTime
                }
            });
        } else {
            res.status(502).json({
                status: 'error',
                message: result.error || 'Webhook test failed',
                data: {
                    executionTime
                }
            });
        }
    } catch (err) {
        const executionTime = Date.now() - startTime;
        logger.error('Webhook test error', { error: err.message, webhookUrl });
        res.status(500).json({
            status: 'error',
            message: err.message,
            data: { executionTime }
        });
    }
});

/**
 * GET /api/tools/available
 * List available built-in tools (not N8N tools)
 * These are tools like /dataapi that are handled by toolService
 */
router.get('/available', optionalAuth, async (req, res) => {
    const builtInTools = [
        {
            id: 'dataapi.files.search',
            name: 'File Search',
            description: 'Search for files in the data storage',
            category: 'dataapi',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' }
                },
                required: ['query']
            }
        },
        {
            id: 'dataapi.files.duplicates',
            name: 'Find Duplicates',
            description: 'Find duplicate files in the data storage',
            category: 'dataapi',
            inputSchema: {
                type: 'object',
                properties: {}
            }
        },
        {
            id: 'dataapi.storage.scan',
            name: 'Storage Scan',
            description: 'Scan storage for analysis',
            category: 'dataapi',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path to scan' }
                }
            }
        },
        {
            id: 'dataapi.storage.status',
            name: 'Storage Status',
            description: 'Get storage status and statistics',
            category: 'dataapi',
            inputSchema: {
                type: 'object',
                properties: {}
            }
        },
        {
            id: 'rag.ingest',
            name: 'RAG Ingest',
            description: 'Ingest documents into the RAG system',
            category: 'rag',
            inputSchema: {
                type: 'object',
                properties: {
                    source: { type: 'string', description: 'Source path or URL' }
                },
                required: ['source']
            }
        },
        {
            id: 'rag.search',
            name: 'RAG Search',
            description: 'Search the RAG knowledge base',
            category: 'rag',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    topK: { type: 'number', description: 'Number of results' }
                },
                required: ['query']
            }
        }
    ];

    res.json({
        status: 'success',
        data: builtInTools
    });
});

module.exports = router;

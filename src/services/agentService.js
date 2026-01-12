/**
 * AgentX Service
 * Business logic for agent management and tool execution
 */

const AgentX = require('../../models/AgentX');
const PromptConfig = require('../../models/PromptConfig');
const { triggerWebhook } = require('../utils/n8nWebhook');
const logger = require('../../config/logger');

/**
 * Get agent by ID with full prompt details
 * @param {string} agentId - Agent ObjectId
 * @returns {Promise<object|null>} Hydrated agent or null
 */
async function getAgent(agentId) {
    return AgentX.getFullAgent(agentId);
}

/**
 * Get active agents for a workspace
 * @param {string|null} workspaceId - Workspace ObjectId or null for global
 * @returns {Promise<array>} List of active agents
 */
async function getActiveAgents(workspaceId = null) {
    return AgentX.getActive(workspaceId);
}

/**
 * Get the default agent for a workspace
 * @param {string|null} workspaceId - Workspace ObjectId or null for global
 * @returns {Promise<object|null>} Default agent or null
 */
async function getDefaultAgent(workspaceId = null) {
    return AgentX.getDefault(workspaceId);
}

/**
 * Build the effective system prompt for an agent
 * Combines the agent's prompt with any additional context
 *
 * @param {object} agent - The agent document (populated with promptConfigId)
 * @param {object} options - Additional options
 * @param {string} options.userProfile - User profile/memory text
 * @param {string} options.ragContext - RAG retrieved context
 * @param {string} options.customInstructions - User's custom instructions
 * @returns {string} The complete system prompt
 */
function buildAgentSystemPrompt(agent, options = {}) {
    const { userProfile, ragContext, customInstructions } = options;

    // Start with the base prompt from PromptConfig
    let systemPrompt = agent.promptConfigId?.systemPrompt ||
        'You are a helpful AI assistant.';

    // Add agent description context
    if (agent.description) {
        systemPrompt += `\n\n[Agent: ${agent.displayName}]\n${agent.description}`;
    }

    // Add RAG context if available
    if (ragContext) {
        systemPrompt += `\n\n=== RETRIEVED CONTEXT ===
You have access to the following retrieved context from the knowledge base.
Use this information to answer the user's questions accurately.
Cite sources when relevant.

${ragContext}

=== END CONTEXT ===`;
    }

    // Add user profile/memory
    if (userProfile) {
        systemPrompt += `\n\nUser Profile/Memory:\n${userProfile}`;
    }

    // Add custom instructions
    if (customInstructions) {
        systemPrompt += `\n\nCustom Instructions:\n${customInstructions}`;
    }

    // Add N8N tool instructions if agent has active tools
    const activeTools = agent.n8nTools?.filter(t => t.isActive) || [];
    if (activeTools.length > 0) {
        systemPrompt += `\n\n=== AVAILABLE TOOLS ===
You have access to the following tools. Use them when appropriate to help the user.

${activeTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

To use a tool, respond with the appropriate function call. The system will execute the tool and provide the result.
=== END TOOLS ===`;
    }

    return systemPrompt;
}

/**
 * Get tool definitions for an agent in Ollama format
 *
 * @param {object} agent - The agent document
 * @returns {array} Array of tool definitions for Ollama
 */
function getAgentToolDefinitions(agent) {
    const tools = [];

    // Add N8N tools
    const n8nTools = agent.n8nTools?.filter(t => t.isActive) || [];
    for (const tool of n8nTools) {
        tools.push({
            type: 'function',
            function: {
                name: `n8n_${tool.toolId}`,
                description: tool.description,
                parameters: tool.inputSchema || {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        });
    }

    return tools;
}

/**
 * Execute an N8N tool for an agent
 *
 * @param {object} agent - The agent document
 * @param {string} toolId - The tool ID (with or without 'n8n_' prefix)
 * @param {object} parameters - Tool parameters from LLM
 * @param {object} context - Execution context
 * @returns {Promise<object>} Tool execution result
 */
async function executeN8nTool(agent, toolId, parameters, context = {}) {
    const tool = agent.findTool(toolId);

    if (!tool) {
        throw new Error(`Tool "${toolId}" not found on agent "${agent.name}"`);
    }

    if (!tool.isActive) {
        throw new Error(`Tool "${toolId}" is currently disabled`);
    }

    const startTime = Date.now();

    logger.info('Executing N8N tool via service', {
        toolId: tool.toolId,
        agentId: agent._id,
        agentName: agent.name
    });

    // Build payload
    const payload = {
        toolId: tool.toolId,
        toolName: tool.name,
        agentId: agent._id.toString(),
        agentName: agent.name,
        parameters: parameters || {},
        context: {
            timestamp: new Date().toISOString(),
            source: 'agentx-chat-service',
            ...context
        }
    };

    // Execute webhook
    const result = await triggerWebhook(tool.webhookUrl, payload, {
        timeout: tool.timeout || 30000
    });

    const executionTime = Date.now() - startTime;

    // Record invocation
    await agent.recordToolInvocation();

    if (result.success) {
        logger.info('N8N tool executed successfully', {
            toolId: tool.toolId,
            executionTime
        });

        return {
            success: true,
            toolId: tool.toolId,
            toolName: tool.name,
            result: result.data,
            executionTime
        };
    } else {
        logger.warn('N8N tool execution failed', {
            toolId: tool.toolId,
            error: result.error,
            executionTime
        });

        return {
            success: false,
            toolId: tool.toolId,
            toolName: tool.name,
            error: result.error || 'Tool execution failed',
            executionTime
        };
    }
}

/**
 * Process tool calls from an LLM response
 *
 * @param {array} toolCalls - Array of tool calls from LLM
 * @param {object} agent - The agent document
 * @param {object} context - Execution context
 * @returns {Promise<array>} Array of tool results
 */
async function processToolCalls(toolCalls, agent, context = {}) {
    const results = [];

    for (const call of toolCalls) {
        const functionName = call.function?.name;
        const args = call.function?.arguments;

        if (!functionName) {
            results.push({
                call_id: call.id,
                error: 'No function name provided'
            });
            continue;
        }

        // Parse arguments if string
        let parameters;
        try {
            parameters = typeof args === 'string' ? JSON.parse(args) : args;
        } catch (e) {
            parameters = {};
        }

        // Handle N8N tools
        if (functionName.startsWith('n8n_')) {
            try {
                const result = await executeN8nTool(agent, functionName, parameters, context);
                results.push({
                    call_id: call.id,
                    function_name: functionName,
                    ...result
                });
            } catch (err) {
                results.push({
                    call_id: call.id,
                    function_name: functionName,
                    success: false,
                    error: err.message
                });
            }
        } else {
            // Unknown tool type
            results.push({
                call_id: call.id,
                function_name: functionName,
                success: false,
                error: `Unknown tool type: ${functionName}`
            });
        }
    }

    return results;
}

/**
 * Create an agent from a PromptConfig (migration helper)
 *
 * @param {object} promptConfig - The PromptConfig document
 * @param {object} options - Additional agent options
 * @returns {Promise<object>} Created agent
 */
async function createAgentFromPrompt(promptConfig, options = {}) {
    const {
        displayName,
        description,
        avatar,
        category,
        defaultModel,
        workspaceId
    } = options;

    // Check if agent already exists for this prompt
    const existing = await AgentX.findOne({
        name: promptConfig.name,
        workspaceId: workspaceId || null
    });

    if (existing) {
        logger.info('Agent already exists for prompt', {
            promptName: promptConfig.name,
            agentId: existing._id
        });
        return existing;
    }

    const agent = new AgentX({
        name: promptConfig.name,
        displayName: displayName || promptConfig.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: description || promptConfig.description || '',
        avatar: avatar || 'fa-robot',
        category: category || 'general',
        promptConfigId: promptConfig._id,
        defaultModel: defaultModel || 'llama3.2:latest',
        workspaceId: workspaceId || promptConfig.workspaceId || null,
        isActive: true,
        n8nTools: [],
        capabilities: {
            supportsRag: true,
            supportsStreaming: true
        }
    });

    await agent.save();

    logger.info('Agent created from prompt', {
        promptName: promptConfig.name,
        agentId: agent._id
    });

    return agent;
}

/**
 * Migrate all existing prompts to agents
 *
 * @param {object} options - Migration options
 * @param {string} options.defaultModel - Default model for new agents
 * @param {boolean} options.dryRun - If true, don't actually create agents
 * @returns {Promise<object>} Migration results
 */
async function migratePromptsToAgents(options = {}) {
    const { defaultModel = 'llama3.2:latest', dryRun = false } = options;

    // Get unique prompt names (latest version of each)
    const prompts = await PromptConfig.aggregate([
        { $sort: { version: -1 } },
        {
            $group: {
                _id: { name: '$name', workspaceId: '$workspaceId' },
                latestPrompt: { $first: '$$ROOT' }
            }
        }
    ]);

    const results = {
        total: prompts.length,
        created: 0,
        skipped: 0,
        errors: [],
        agents: []
    };

    for (const { latestPrompt } of prompts) {
        try {
            // Check if agent exists
            const existing = await AgentX.findOne({
                name: latestPrompt.name,
                workspaceId: latestPrompt.workspaceId || null
            });

            if (existing) {
                results.skipped++;
                continue;
            }

            if (dryRun) {
                results.agents.push({
                    name: latestPrompt.name,
                    wouldCreate: true
                });
                results.created++;
                continue;
            }

            const agent = await createAgentFromPrompt(latestPrompt, { defaultModel });
            results.agents.push({
                name: agent.name,
                id: agent._id
            });
            results.created++;
        } catch (err) {
            results.errors.push({
                name: latestPrompt.name,
                error: err.message
            });
        }
    }

    logger.info('Prompt migration complete', results);

    return results;
}

module.exports = {
    getAgent,
    getActiveAgents,
    getDefaultAgent,
    buildAgentSystemPrompt,
    getAgentToolDefinitions,
    executeN8nTool,
    processToolCalls,
    createAgentFromPrompt,
    migratePromptsToAgents
};

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');

const DATAAPI_BASE_URL = process.env.DATAAPI_BASE_URL || 'http://localhost:3003';
const DATAAPI_API_KEY = process.env.DATAAPI_API_KEY;
const AGENTX_BASE_URL = process.env.AGENTX_BASE_URL || 'http://localhost:3080';
const N8N_API_KEY = process.env.N8N_API_KEY;

// Validate environment variables on load
if (!DATAAPI_API_KEY) {
    logger.warn('DATAAPI_API_KEY not set - DataAPI tools may fail authentication');
}
if (!N8N_API_KEY) {
    logger.warn('N8N_API_KEY not set - n8n tools may fail authentication');
}

const AVAILABLE_TOOLS = {
    // DataAPI tools
    'dataapi.storage_scans': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/storage/scans`,
        headers: { 'x-api-key': DATAAPI_API_KEY },
        description: 'List all storage scan records'
    },
    'dataapi.system_health': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/system/health`,
        headers: { 'x-api-key': DATAAPI_API_KEY },
        description: 'Get aggregated health status (MongoDB, Ollama hosts)'
    },
    'dataapi.storage_summary': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/storage/summary`,
        headers: { 'x-api-key': DATAAPI_API_KEY },
        description: 'Get storage summary (file counts, duplicates, pending deletions)'
    },
    'dataapi.file_stats': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/files/stats`,
        headers: { 'x-api-key': DATAAPI_API_KEY },
        description: 'Get file statistics by extension and size'
    },
    'dataapi.duplicates': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/files/duplicates`,
        headers: { 'x-api-key': DATAAPI_API_KEY },
        description: 'Find duplicate files by SHA256 hash'
    },
    'dataapi.janitor_pending': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/janitor/pending-deletions`,
        headers: { 'x-api-key': DATAAPI_API_KEY },
        description: 'Get pending file deletions from Janitor'
    },
    // AgentX tools
    'agentx.n8n_health': {
        method: 'GET',
        url: `${AGENTX_BASE_URL}/api/n8n/health`,
        headers: { 'x-api-key': N8N_API_KEY },
        description: 'Check AgentX n8n integration health'
    },
    // Integration tools
    'n8n.log_event': {
        method: 'POST',
        url: `${DATAAPI_BASE_URL}/integrations/events/n8n`,
        headers: { 'Content-Type': 'application/json' },
        description: 'Log an event to DataAPI event sink'
    }
};

/**
 * Execute a tool by name
 * @param {string} toolName
 * @param {object} params
 */
async function executeTool(toolName, params = {}) {
    const tool = AVAILABLE_TOOLS[toolName];
    if (!tool) {
        throw new Error(`Tool '${toolName}' not found`);
    }

    try {
        const options = {
            method: tool.method,
            headers: {
                'Content-Type': 'application/json',
                ...tool.headers
            }
        };

        if (tool.method === 'POST' || tool.method === 'PUT') {
            options.body = JSON.stringify(params);
        }

        const response = await fetch(tool.url, options);
        const data = await response.json();

        return {
            status: 'success',
            tool: toolName,
            data
        };
    } catch (error) {
        logger.error(`Tool execution failed: ${toolName}`, { error: error.message });
        return {
            status: 'error',
            tool: toolName,
            error: error.message
        };
    }
}

/**
 * Parse response for tool calls
 * Expected format: ```json { "tool": "name", "params": {} } ```
 * Supports multiple tool calls in one response
 * @param {string} text
 * @returns {object|null} First valid tool call found, or null
 */
function parseToolCalls(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    // Match all JSON code blocks
    const toolBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    const matches = [...text.matchAll(toolBlockRegex)];

    for (const match of matches) {
        try {
            const parsed = JSON.parse(match[1]);
            
            // Validate required structure
            if (!parsed.tool || typeof parsed.tool !== 'string') {
                continue;
            }
            
            // Check if tool exists
            if (!AVAILABLE_TOOLS[parsed.tool]) {
                logger.warn(`Unknown tool requested: ${parsed.tool}`, {
                    availableTools: Object.keys(AVAILABLE_TOOLS)
                });
                continue;
            }
            
            // Return first valid tool call
            return {
                tool: parsed.tool,
                params: parsed.params || {}
            };
        } catch (e) {
            // Not valid JSON, skip this block
            logger.debug('Skipped non-tool JSON block', { error: e.message });
        }
    }
    
    return null;
}

/**
 * Get list of available tools with descriptions
 * Useful for building system prompts
 */
function getToolDescriptions() {
    return Object.entries(AVAILABLE_TOOLS).map(([name, config]) => ({
        name,
        method: config.method,
        description: config.description || 'No description'
    }));
}

/**
 * Format tool result for display
 * @param {object} result - Tool execution result
 * @returns {string} Formatted result
 */
function formatToolResult(result) {
    if (result.status === 'error') {
        return `❌ Tool "${result.tool}" failed: ${result.error}`;
    }
    
    const data = result.data;
    
    // Handle common response formats
    if (data?.status === 'success' && data?.data) {
        return `✓ ${result.tool}: ${JSON.stringify(data.data, null, 2)}`;
    }
    
    return `✓ ${result.tool}: ${JSON.stringify(data, null, 2)}`;
}

module.exports = {
    AVAILABLE_TOOLS,
    executeTool,
    parseToolCalls,
    getToolDescriptions,
    formatToolResult
};

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');

const DATAAPI_BASE_URL = process.env.DATAAPI_BASE_URL || 'http://localhost:3003';
const DATAAPI_API_KEY = process.env.DATAAPI_API_KEY;
const AGENTX_BASE_URL = process.env.AGENTX_BASE_URL || 'http://localhost:3080';
const N8N_API_KEY = process.env.N8N_API_KEY;

const AVAILABLE_TOOLS = {
    'dataapi.storage_scans': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/storage/scans`,
        headers: { 'x-api-key': DATAAPI_API_KEY }
    },
    'dataapi.system_health': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/health`, // Assuming health endpoint
        headers: { 'x-api-key': DATAAPI_API_KEY }
    },
    'dataapi.storage_summary': {
        method: 'GET',
        url: `${DATAAPI_BASE_URL}/api/v1/files/stats`,
        headers: { 'x-api-key': DATAAPI_API_KEY }
    },
    'agentx.n8n_health': {
        method: 'GET',
        url: `${AGENTX_BASE_URL}/api/n8n/health`,
        headers: { 'x-api-key': N8N_API_KEY }
    },
    'n8n.log_event': {
        method: 'POST',
        url: `${DATAAPI_BASE_URL}/integrations/events/n8n`,
        headers: { 'x-api-key': DATAAPI_API_KEY }
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
 * @param {string} text
 */
function parseToolCalls(text) {
    const toolBlockRegex = /```json\s*(\{\s*"tool":\s*".*?"\s*.*?\})\s*```/s;
    const match = text.match(toolBlockRegex);

    if (match && match[1]) {
        try {
            const toolCall = JSON.parse(match[1]);
            if (toolCall.tool && AVAILABLE_TOOLS[toolCall.tool]) {
                return toolCall;
            }
        } catch (e) {
            logger.warn('Failed to parse potential tool call', { error: e.message });
        }
    }
    return null;
}

module.exports = {
    AVAILABLE_TOOLS,
    executeTool,
    parseToolCalls
};

const logger = require('../../config/logger');

/**
 * Fetch with timeout and retry capability
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options with timeout and retries
 * @returns {Promise<Response>}
 */
async function fetchWithTimeoutAndRetry(url, options = {}) {
  const { timeout = 30000, retries = 1, name = 'fetch' } = options;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        logger.warn(`[${name}] Attempt ${attempt + 1} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

/**
 * Trigger an n8n webhook
 * @param {string} webhookId - The webhook ID from n8n
 * @param {object} data - Payload to send to n8n
 * @param {object} options - Optional configuration
 * @returns {Promise<object>} n8n response
 */
async function triggerWebhook(webhookId, data = {}, options = {}) {
  const n8nBaseUrl = process.env.N8N_WEBHOOK_BASE_URL || 'https://n8n.specialblend.icu/webhook';
  const url = `${n8nBaseUrl}/${webhookId}`;
  const timeout = options.timeout || parseInt(process.env.N8N_WEBHOOK_TIMEOUT_MS) || 120000; // 2 minutes for AI agents (Ollama can be slow)
  const requestStart = Date.now();

  try {
    logger.info(`[n8n] Starting webhook: ${webhookId} (timeout: ${timeout}ms)`);
    
    const response = await fetchWithTimeoutAndRetry(url, {
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      body: JSON.stringify(data),
      timeout,
      retries: options.retries || 1,
      name: 'n8n-webhook'
    });

    const result = await response.json();
    const elapsed = Date.now() - requestStart;
    
    logger.info(`[n8n] Webhook response: ${webhookId} (${elapsed}ms)`);
    
    return {
      success: true,
      status: response.status,
      data: result
    };
  } catch (error) {
    const elapsed = Date.now() - requestStart;
    logger.warn(`[n8n] Webhook failed: ${webhookId} after ${elapsed}ms - ${error.message}`);
    
    // Don't throw - just log and return failure
    // This prevents n8n being down from breaking AgentX
    return {
      success: false,
      error: error.message,
      webhookId
    };
  }
}

/**
 * Common webhook triggers for AgentX events
 */
const triggers = {
  /**
   * Trigger when a RAG ingestion completes
   */
  ragIngest: async (ingestData) => {
    const webhookId = process.env.N8N_WEBHOOK_RAG_INGEST || 'rag-ingest-webhook-id';
    const summary = `RAG ingestion completed: ${ingestData.documentsProcessed || 0} documents processed`;
    return triggerWebhook(webhookId, {
      chatInput: summary,
      event: 'rag_ingest_complete',
      ingest: ingestData,
      timestamp: new Date().toISOString(),
      source: 'agentx'
    });
  },

  /**
   * Trigger when AI chat session completes
   */
  chatComplete: async (chatData) => {
    const webhookId = process.env.N8N_WEBHOOK_CHAT_COMPLETE || 'chat-complete-webhook-id';
    const summary = `Chat session completed: ${chatData.messages || 0} messages exchanged`;
    return triggerWebhook(webhookId, {
      chatInput: summary,
      event: 'chat_complete',
      chat: chatData,
      timestamp: new Date().toISOString(),
      source: 'agentx'
    });
  },

  /**
   * Trigger when analytics event occurs
   */
  analytics: async (analyticsData) => {
    const webhookId = process.env.N8N_WEBHOOK_ANALYTICS || 'analytics-webhook-id';
    const summary = `Analytics event: ${analyticsData.type || 'unknown'}`;
    return triggerWebhook(webhookId, {
      chatInput: summary,
      event: 'analytics',
      analytics: analyticsData,
      timestamp: new Date().toISOString(),
      source: 'agentx'
    });
  },

  /**
   * Generic event trigger
   */
  event: async (eventName, eventData) => {
    const webhookId = process.env.N8N_WEBHOOK_GENERIC || 'generic-webhook-id';
    const summary = `Event: ${eventName}`;
    return triggerWebhook(webhookId, {
      chatInput: summary,
      event: eventName,
      data: eventData,
      timestamp: new Date().toISOString(),
      source: 'agentx'
    });
  }
};

module.exports = {
  triggerWebhook,
  triggers
};

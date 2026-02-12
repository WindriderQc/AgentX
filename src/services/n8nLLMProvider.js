/**
 * n8n LLM Provider Service
 *
 * Enables AgentX to use cloud LLM APIs (OpenAI, Anthropic, Google) via n8n webhooks.
 * This allows users to configure n8n workflows that proxy to various LLM providers
 * and use them seamlessly alongside local Ollama models.
 */

const fetch = require('node-fetch');
const logger = require('../../config/logger');

class N8nLLMProvider {
  constructor() {
    this.n8nBase = process.env.N8N_URL || 'http://localhost:5678';
    this.timeout = 60000; // 60 seconds for LLM responses
  }

  /**
   * Send chat request to n8n webhook LLM
   * @param {string} webhookUrl - Full n8n webhook URL
   * @param {Array} messages - Chat messages in OpenAI format
   * @param {Object} options - Additional options (model, temperature, etc.)
   * @returns {Promise<Object>} - LLM response
   */
  async chat(webhookUrl, messages, options = {}) {
    try {
      const startTime = Date.now();

      // Construct payload in format n8n expects
      const payload = {
        messages,
        model: options.model || 'default',
        temperature: options.temperature || 0.7,
        max_tokens: options.maxTokens || 2048,
        stream: options.stream || false,
        metadata: {
          source: 'agentx',
          conversationId: options.conversationId,
          userId: options.userId
        }
      };

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        timeout: this.timeout
      });

      if (!response.ok) {
        throw new Error(`n8n webhook returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const latency = Date.now() - startTime;

      // Normalize response to standard format
      const normalizedResponse = this._normalizeResponse(data);

      logger.info('n8n LLM request completed', {
        webhookUrl: webhookUrl.substring(0, 50) + '...',
        latency,
        model: options.model,
        messageCount: messages.length
      });

      return {
        ...normalizedResponse,
        _metadata: {
          provider: 'n8n',
          latency,
          webhookUrl
        }
      };

    } catch (error) {
      logger.error('n8n LLM request failed', {
        webhookUrl: webhookUrl.substring(0, 50) + '...',
        error: error.message
      });

      throw new Error(`n8n LLM request failed: ${error.message}`);
    }
  }

  /**
   * Normalize different n8n response formats to standard format
   * @param {Object} data - Raw n8n response
   * @returns {Object} - Normalized response
   */
  _normalizeResponse(data) {
    // OpenAI format (most common)
    if (data.choices && data.choices[0]?.message) {
      return {
        content: data.choices[0].message.content,
        role: data.choices[0].message.role || 'assistant',
        finishReason: data.choices[0].finish_reason,
        usage: data.usage || null
      };
    }

    // Anthropic format
    if (data.content && Array.isArray(data.content)) {
      const textContent = data.content.find(c => c.type === 'text');
      return {
        content: textContent?.text || '',
        role: data.role || 'assistant',
        usage: {
          inputTokens: data.usage?.input_tokens,
          outputTokens: data.usage?.output_tokens
        }
      };
    }

    // Simple text response
    if (data.response || data.text || data.content) {
      return {
        content: data.response || data.text || data.content,
        role: 'assistant'
      };
    }

    // Unknown format - return as-is with warning
    logger.warn('Unknown n8n response format', { data });
    return {
      content: JSON.stringify(data),
      role: 'assistant',
      _raw: data
    };
  }

  /**
   * Test webhook availability and response time
   * @param {string} webhookUrl - n8n webhook URL to test
   * @returns {Promise<Object>} - Health check result
   */
  async healthCheck(webhookUrl) {
    try {
      const startTime = Date.now();

      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'test' }],
          metadata: { test: true, source: 'agentx-health-check' }
        }),
        timeout: 10000 // 10 second timeout for health checks
      });

      const latency = Date.now() - startTime;
      const ok = response.ok;

      return {
        available: ok,
        latency,
        statusCode: response.status,
        statusText: response.statusText
      };

    } catch (error) {
      return {
        available: false,
        latency: null,
        error: error.message
      };
    }
  }

  /**
   * Convert messages to n8n-compatible format
   * @param {Array} messages - Messages in various formats
   * @returns {Array} - n8n-compatible messages
   */
  _normalizeMessages(messages) {
    if (!Array.isArray(messages)) {
      return [{ role: 'user', content: String(messages) }];
    }

    return messages.map(msg => {
      if (typeof msg === 'string') {
        return { role: 'user', content: msg };
      }

      return {
        role: msg.role || 'user',
        content: msg.content || ''
      };
    });
  }
}

// Export singleton instance
module.exports = new N8nLLMProvider();

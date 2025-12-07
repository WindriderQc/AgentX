/**
 * Ollama Response Handler
 * Utilities for extracting and processing Ollama API responses
 */

const logger = require('../../config/logger');

/**
 * Detect if model has thinking/reasoning capabilities
 * @param {string} model - Model name
 * @returns {boolean}
 */
function isThinkingModel(model) {
  const thinkingModels = [
    'qwen', 'deepseek-r1', 'deepthink', 'o1', 'o3', 'reasoning'
  ];
  return thinkingModels.some(pattern => 
    model.toLowerCase().includes(pattern)
  );
}

/**
 * Extract assistant response from Ollama API response
 * Handles various response formats and thinking model outputs
 * 
 * @param {Object} data - Ollama API response
 * @param {string} model - Model name for context
 * @returns {Object} { content: string, thinking: string|null, warning: string|null }
 */
function extractResponse(data, model) {
  const result = {
    content: '',
    thinking: null,
    warning: null
  };

  // Check various response fields
  const hasMessageContent = data.message?.content && data.message.content.trim() !== '';
  const hasThinking = data.message?.thinking && data.message.thinking.trim() !== '';
  const hasResponse = data.response && data.response.trim() !== '';
  
  // Log response structure for debugging
  logger.debug('Ollama response structure', { 
    model,
    hasMessageContent,
    messageContentLength: data.message?.content?.length || 0,
    hasThinking,
    thinkingLength: data.message?.thinking?.length || 0,
    hasResponse,
    responseLength: data.response?.length || 0,
    done: data.done
  });

  // For thinking models, preserve thinking process
  if (isThinkingModel(model) && hasThinking) {
    result.thinking = data.message.thinking.trim();
  }

  // Priority order for response content:
  // 1. message.content (new chat API format)
  // 2. response (legacy generate API format)
  // 3. message.thinking (fallback for thinking-only responses)
  
  if (hasMessageContent) {
    result.content = data.message.content.trim();
  } else if (hasResponse) {
    result.content = data.response.trim();
  } else if (hasThinking) {
    // Use thinking as content if no other response available
    result.content = data.message.thinking.trim();
    result.warning = 'Used thinking output as response (no content field)';
    logger.warn('Using thinking as response', { model, reason: 'No content field' });
  }

  // Check for incomplete responses
  if (data.done === false) {
    result.warning = 'Incomplete response - model may require streaming';
    logger.warn('Incomplete response received', { model, done: data.done });
  }

  // Validate we got something
  if (!result.content) {
    result.warning = 'Empty response from Ollama';
    logger.error('Empty response from Ollama', { 
      model,
      responseKeys: Object.keys(data),
      hasMessage: !!data.message,
      messageKeys: data.message ? Object.keys(data.message) : []
    });
  }

  return result;
}

/**
 * Build Ollama API payload with optimized settings
 * @param {Object} params - Request parameters
 * @returns {Object} Ollama API payload
 */
function buildOllamaPayload(params) {
  const {
    model,
    messages,
    options = {},
    streamEnabled = false
  } = params;

  const payload = {
    model,
    messages,
    stream: streamEnabled,
    options: {
      ...options,
      // For non-streaming: disable token limit to get complete responses
      num_predict: streamEnabled ? (options.num_predict || 256) : -1
    }
  };

  // For thinking models in non-streaming mode, ensure proper token limits
  if (!streamEnabled && isThinkingModel(model)) {
    // Allow larger context for thinking models
    payload.options.num_ctx = options.num_ctx || 8192;
  }

  return payload;
}

module.exports = {
  isThinkingModel,
  extractResponse,
  buildOllamaPayload
};

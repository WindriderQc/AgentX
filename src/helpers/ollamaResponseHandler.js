/**
 * Ollama Response Handler
 * Utilities for extracting and processing Ollama API responses
 */

const logger = require('../../config/logger');

// Regex patterns for cleaning leaked Llama 3 template tags
// These patterns are defined as constants to avoid repeated regex compilation
// Llama 3 format: <|start_header_id|>role<|end_header_id|>
const LLAMA3_HEADER_REGEX = /<\|start_header_id\|>.*?<\|end_header_id\|>/g;

// Other special tokens: <|eot_id|>, <|begin_of_text|>, etc.
const LLAMA3_SPECIAL_TOKENS_REGEX = /<\|(eot_id|begin_of_text|end_of_text|fin)\|>/g;

/**
 * Detect if model has thinking/reasoning capabilities
 * @param {string} model - Model name
 * @returns {boolean}
 */
function isThinkingModel(model) {
  if (!model) return false;
  const thinkingModels = [
    'qwen', 'deepseek-r1', 'deepthink', 'o1', 'o3', 'reasoning'
  ];
  return thinkingModels.some(pattern => 
    model.toLowerCase().includes(pattern)
  );
}

/**
 * Clean up content by removing known leaked template tags (e.g. Llama 3 headers)
 * @param {string} content
 * @returns {string}
 */
function cleanContent(content) {
  if (!content) return content;

  return content
    .replace(LLAMA3_HEADER_REGEX, '')
    .replace(LLAMA3_SPECIAL_TOKENS_REGEX, '')
    .trim();
}

/**
 * Extract assistant response from Ollama API response
 * Handles various response formats and thinking model outputs
 * 
 * @param {Object} data - Ollama API response
 * @param {string} model - Model name for context
 * @returns {Object} { content: string, thinking: string|null, warning: string|null, stats: Object|null }
 */
function extractResponse(data, model) {
  const result = {
    content: '',
    thinking: null,
    warning: null,
    stats: null
  };

  // V4: Extract detailed usage stats if available
  if (data.done && (data.eval_count || data.prompt_eval_count)) {
    const totalDuration = data.total_duration || 0;
    const loadDuration = data.load_duration || 0;
    const evalDuration = data.eval_duration || 0;
    const evalCount = data.eval_count || 0;

    // Calculate tokens per second (avoid division by zero)
    // eval_duration is in nanoseconds. 1e9 ns = 1s.
    const durationSeconds = evalDuration / 1e9;
    const tokensPerSecond = durationSeconds > 0 ? (evalCount / durationSeconds) : 0;

    result.stats = {
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: evalCount,
        totalTokens: (data.prompt_eval_count || 0) + evalCount
      },
      performance: {
        totalDuration,
        loadDuration,
        evalDuration,
        tokensPerSecond: Number(tokensPerSecond.toFixed(2))
      }
    };
  }

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
  
  let rawContent = '';
  if (hasMessageContent) {
    rawContent = data.message.content;
  } else if (hasResponse) {
    rawContent = data.response;
  } else if (hasThinking) {
    // Use thinking as content if no other response available
    rawContent = data.message.thinking;
    result.warning = 'Used thinking output as response (no content field)';
    logger.warn('Using thinking as response', { model, reason: 'No content field' });
  }

  // Clean the content
  const cleanedContent = cleanContent(rawContent);

  // If originally non-empty content became empty after cleaning (e.g. only tags),
  // log for debugging purposes
  if (rawContent && String(rawContent).trim() && !cleanedContent) {
    logger.warn('Content became empty after cleaning', {
      model,
      originalLength: String(rawContent).length
    });
  }

  result.content = cleanedContent;

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
  buildOllamaPayload,
  cleanContent  // Export for testing
};

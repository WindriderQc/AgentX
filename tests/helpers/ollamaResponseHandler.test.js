/**
 * Ollama Response Handler Tests
 * Tests for cleaning leaked template tags and response extraction
 */

const {
  cleanContent,
  isThinkingModel,
  extractResponse,
  buildOllamaPayload
} = require('../../src/helpers/ollamaResponseHandler');

describe('Ollama Response Handler', () => {
  describe('cleanContent', () => {
    it('should return content unchanged if no tags are present', () => {
      const content = 'This is a normal response without any tags.';
      expect(cleanContent(content)).toBe(content);
    });

    it('should remove properly formatted Llama 3 header tags', () => {
      const content = '<|start_header_id|>user<|end_header_id|>Hello, how are you?';
      const expected = 'Hello, how are you?';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove multiple header tag pairs', () => {
      const content = '<|start_header_id|>user<|end_header_id|>Question<|start_header_id|>assistant<|end_header_id|>Answer';
      const expected = 'QuestionAnswer';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove eot_id token', () => {
      const content = 'Response text<|eot_id|>';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove begin_of_text token', () => {
      const content = '<|begin_of_text|>Response text';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove end_of_text token', () => {
      const content = 'Response text<|end_of_text|>';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove fin token', () => {
      const content = 'Response text<|fin|>';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove all special tokens in combination', () => {
      const content = '<|begin_of_text|><|start_header_id|>user<|end_header_id|>Hello<|eot_id|>';
      const expected = 'Hello';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle content with only tags (becomes empty)', () => {
      const content = '<|start_header_id|>system<|end_header_id|>';
      const expected = '';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle empty string input', () => {
      expect(cleanContent('')).toBe('');
    });

    it('should handle null input', () => {
      expect(cleanContent(null)).toBe(null);
    });

    it('should handle undefined input', () => {
      expect(cleanContent(undefined)).toBe(undefined);
    });

    it('should trim whitespace after tag removal', () => {
      const content = '  <|start_header_id|>user<|end_header_id|>  Hello  ';
      const expected = 'Hello';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should preserve legitimate content with pipe characters', () => {
      const content = 'Use the | operator in shell commands';
      expect(cleanContent(content)).toBe(content);
    });

    it('should preserve legitimate content with angle brackets', () => {
      const content = 'Array<string> is a TypeScript type';
      expect(cleanContent(content)).toBe(content);
    });

    it('should preserve content with partial tag-like patterns', () => {
      const content = 'The <start> tag and |end| marker';
      expect(cleanContent(content)).toBe(content);
    });

    it('should handle multiline content with tags', () => {
      const content = '<|start_header_id|>user<|end_header_id|>\nLine 1\nLine 2<|eot_id|>';
      const expected = 'Line 1\nLine 2';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle tags with different role names', () => {
      const content = '<|start_header_id|>assistant<|end_header_id|>Response';
      const expected = 'Response';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle tags in the middle of content', () => {
      const content = 'Start <|start_header_id|>system<|end_header_id|> End';
      const expected = 'Start  End';
      expect(cleanContent(content)).toBe('Start  End'.trim());
    });
  });

  describe('isThinkingModel', () => {
    it('should return true for qwen models', () => {
      expect(isThinkingModel('qwen2.5:7b-instruct-q4_0')).toBe(true);
    });

    it('should return true for deepseek-r1 models', () => {
      expect(isThinkingModel('deepseek-r1:8b')).toBe(true);
    });

    it('should return true for models with "reasoning" in name', () => {
      expect(isThinkingModel('custom-reasoning-model')).toBe(true);
    });

    it('should return false for standard models', () => {
      expect(isThinkingModel('llama3')).toBe(false);
    });

    it('should return false for null', () => {
      expect(isThinkingModel(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isThinkingModel(undefined)).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isThinkingModel('QWEN-2.5')).toBe(true);
    });
  });

  describe('extractResponse', () => {
    it('should extract content from message.content', () => {
      const data = {
        message: {
          content: 'Response from model'
        },
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('Response from model');
      expect(result.thinking).toBe(null);
    });

    it('should extract content from response field (legacy format)', () => {
      const data = {
        response: 'Legacy response format',
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('Legacy response format');
    });

    it('should clean leaked tags from response', () => {
      const data = {
        message: {
          content: '<|start_header_id|>assistant<|end_header_id|>Clean response<|eot_id|>'
        },
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('Clean response');
    });

    it('should extract thinking for thinking models', () => {
      const data = {
        message: {
          content: 'Final answer',
          thinking: 'Internal reasoning process'
        },
        done: true
      };
      const result = extractResponse(data, 'qwen2.5:7b');
      expect(result.content).toBe('Final answer');
      expect(result.thinking).toBe('Internal reasoning process');
    });

    it('should not extract thinking for non-thinking models', () => {
      const data = {
        message: {
          content: 'Final answer',
          thinking: 'Internal reasoning process'
        },
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('Final answer');
      expect(result.thinking).toBe(null);
    });

    it('should set warning for incomplete responses', () => {
      const data = {
        message: {
          content: 'Partial'
        },
        done: false
      };
      const result = extractResponse(data, 'llama3');
      expect(result.warning).toBe('Incomplete response - model may require streaming');
    });

    it('should set warning for empty responses', () => {
      const data = {
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.warning).toBe('Empty response from Ollama');
    });

    it('should extract usage statistics when available', () => {
      const data = {
        message: {
          content: 'Response'
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 50,
        total_duration: 1000000000,
        load_duration: 100000000,
        eval_duration: 500000000
      };
      const result = extractResponse(data, 'llama3');
      expect(result.stats).toBeDefined();
      expect(result.stats.usage.promptTokens).toBe(100);
      expect(result.stats.usage.completionTokens).toBe(50);
      expect(result.stats.usage.totalTokens).toBe(150);
      expect(result.stats.performance.tokensPerSecond).toBeGreaterThan(0);
    });
  });

  describe('buildOllamaPayload', () => {
    it('should build basic payload', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }]
      };
      const payload = buildOllamaPayload(params);
      expect(payload.model).toBe('llama3');
      expect(payload.messages).toEqual(params.messages);
      expect(payload.stream).toBe(false);
      expect(payload.options.num_predict).toBe(-1);
    });

    it('should enable streaming when requested', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        streamEnabled: true
      };
      const payload = buildOllamaPayload(params);
      expect(payload.stream).toBe(true);
      expect(payload.options.num_predict).toBe(256);
    });

    it('should set larger context for thinking models', () => {
      const params = {
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hello' }],
        streamEnabled: false
      };
      const payload = buildOllamaPayload(params);
      expect(payload.options.num_ctx).toBe(8192);
    });

    it('should merge custom options', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        options: {
          temperature: 0.7,
          top_p: 0.9
        }
      };
      const payload = buildOllamaPayload(params);
      expect(payload.options.temperature).toBe(0.7);
      expect(payload.options.top_p).toBe(0.9);
    });
  });
});

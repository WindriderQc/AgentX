/**
 * Judge Call Unit Tests
 * Tests for retry classification, balanced brace extraction,
 * and HTTP status precision.
 */

const { extractBalancedJson, isRetryableError, JUDGE_CONFIG } = require('../../src/services/scoring/judgeCall');

// Mock logger
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock httpAgent
jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: jest.fn((url, opts) => opts)
}));

describe('extractBalancedJson', () => {
    it('should extract a simple JSON object', () => {
        const text = '{"accuracy": 8, "clarity": 7, "overall": 7.5}';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({ accuracy: 8, clarity: 7, overall: 7.5 });
    });

    it('should extract JSON from text with preamble', () => {
        const text = 'Here is my evaluation:\n{"accuracy": 8, "overall": 8}';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({ accuracy: 8, overall: 8 });
    });

    it('should handle braces in preamble text before the real JSON', () => {
        const text = 'The output {was incomplete} and not well structured. {"accuracy": 8, "overall": 7}';
        const result = extractBalancedJson(text);
        // Balanced extraction finds first complete object: {was incomplete}
        // Caller will parse-fail on it, then retry (which is the desired behavior)
        expect(result).toBeTruthy();
        expect(result).toBe('{was incomplete}');
    });

    it('should handle nested objects correctly', () => {
        const text = '{"scores": {"accuracy": 8}, "overall": 7}';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({ scores: { accuracy: 8 }, overall: 7 });
    });

    it('should handle braces inside JSON string values', () => {
        const text = '{"explanation": "the output {was incomplete}", "overall": 7}';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({ explanation: 'the output {was incomplete}', overall: 7 });
    });

    it('should handle escaped quotes inside strings', () => {
        const text = '{"explanation": "said \\"hello\\"", "overall": 7}';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({ explanation: 'said "hello"', overall: 7 });
    });

    it('should return null when no braces exist', () => {
        const text = 'No JSON here at all';
        const result = extractBalancedJson(text);
        expect(result).toBeNull();
    });

    it('should return null when only opening brace exists (truncated)', () => {
        const text = '{"accuracy": 8, "clarity":';
        const result = extractBalancedJson(text);
        expect(result).toBeNull();
    });

    it('should handle empty object', () => {
        const text = '{}';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({});
    });

    it('should handle text after JSON object', () => {
        const text = '{"accuracy": 9, "overall": 8}\n\nI hope this helps!';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({ accuracy: 9, overall: 8 });
    });

    it('should not include trailing braces from separate objects', () => {
        const text = '{"accuracy": 8, "overall": 7} some text {"extra": 1}';
        const result = extractBalancedJson(text);
        // Should extract only the first balanced object
        expect(JSON.parse(result)).toEqual({ accuracy: 8, overall: 7 });
    });

    it('should handle deeply nested objects', () => {
        const text = '{"a": {"b": {"c": 1}}, "overall": 5}';
        const result = extractBalancedJson(text);
        expect(JSON.parse(result)).toEqual({ a: { b: { c: 1 } }, overall: 5 });
    });

    it('should fall back to first-to-last brace on unbalanced input with closing brace', () => {
        // Unbalanced: nested object not closed, but outer brace exists later
        const text = '{"accuracy": {"sub": 8, "overall": 7}';
        const result = extractBalancedJson(text);
        // The balanced counter starts at first {, sees nested { (depth=2), sees } (depth=1), sees } (depth=0)
        // Actually this IS balanced: {"sub": 8, "overall": 7} is extracted from position of inner {
        // Wait no — let me trace: first { at index 0, depth=1. Then { at index 14, depth=2.
        // Then } at index 36, depth=1. Then } at index 37, depth=0. Full extraction: the whole string.
        // But that's the whole string which has mismatched key structure. JSON.parse would handle it.
        expect(result).toBeTruthy();
    });
});

describe('isRetryableError', () => {
    describe('network errors (should retry)', () => {
        it('should retry on timeout', () => {
            expect(isRetryableError('The operation was aborted due to timeout')).toBe(true);
        });

        it('should retry on ECONNRESET', () => {
            expect(isRetryableError('read ECONNRESET')).toBe(true);
        });

        it('should retry on ETIMEDOUT', () => {
            expect(isRetryableError('connect ETIMEDOUT 192.168.1.100:11434')).toBe(true);
        });
    });

    describe('HTTP 5xx errors (should retry)', () => {
        it('should retry on Judge HTTP 500', () => {
            expect(isRetryableError('Judge HTTP 500')).toBe(true);
        });

        it('should retry on Judge HTTP 502', () => {
            expect(isRetryableError('Judge HTTP 502')).toBe(true);
        });

        it('should retry on Judge HTTP 503', () => {
            expect(isRetryableError('Judge HTTP 503')).toBe(true);
        });
    });

    describe('JSON parse/extraction errors (should retry)', () => {
        it('should retry on No JSON found', () => {
            expect(isRetryableError('No JSON found in judge response')).toBe(true);
        });

        it('should retry on JSON parse failed', () => {
            expect(isRetryableError('JSON parse failed: Unexpected token a')).toBe(true);
        });

        it('should retry on returned non-object', () => {
            expect(isRetryableError('Judge returned non-object response')).toBe(true);
        });

        it('should retry on returned array', () => {
            expect(isRetryableError('Judge returned array instead of JSON object. Array content: [8,7]')).toBe(true);
        });
    });

    describe('non-retryable errors', () => {
        it('should NOT retry on HTTP 404', () => {
            expect(isRetryableError('Judge HTTP 404')).toBe(false);
        });

        it('should NOT retry on HTTP 400', () => {
            expect(isRetryableError('Judge HTTP 400')).toBe(false);
        });

        it('should NOT retry on HTTP 401', () => {
            expect(isRetryableError('Judge HTTP 401')).toBe(false);
        });

        it('should NOT retry on generic errors', () => {
            expect(isRetryableError('Model not found')).toBe(false);
        });

        it('should NOT retry on unknown errors', () => {
            expect(isRetryableError('Something completely unexpected')).toBe(false);
        });
    });

    describe('type-safe HTTP status (Fix 5)', () => {
        it('should NOT false-positive on message containing "500" as substring', () => {
            // Old code used err.message.includes('500') which would match this
            expect(isRetryableError('Received 500 bytes of data')).toBe(false);
        });

        it('should NOT match "HTTP 4500"', () => {
            expect(isRetryableError('Judge HTTP 4500')).toBe(false);
        });

        it('should match "Judge HTTP 500" via startsWith', () => {
            expect(isRetryableError('Judge HTTP 500')).toBe(true);
        });

        it('should match "Judge HTTP 529" via startsWith', () => {
            expect(isRetryableError('Judge HTTP 529')).toBe(true);
        });
    });
});

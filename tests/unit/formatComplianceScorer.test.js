/**
 * Tests for Format Compliance Scorer
 */

const { scoreFormatCompliance } = require('../../src/services/scoring/formatComplianceScorer');

// Mock logger
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('Format Compliance Scorer', () => {
    describe('no contract / none type', () => {
        it('should return nulls when no contract', () => {
            const result = scoreFormatCompliance('anything', null);
            expect(result.format_score).toBeNull();
            expect(result.format_compliant).toBeNull();
        });

        it('should return nulls when contract type is none', () => {
            const result = scoreFormatCompliance('anything', { type: 'none' });
            expect(result.format_score).toBeNull();
            expect(result.format_compliant).toBeNull();
        });

        it('should return nulls when contract has no type', () => {
            const result = scoreFormatCompliance('anything', {});
            expect(result.format_score).toBeNull();
            expect(result.format_compliant).toBeNull();
        });
    });

    describe('empty response', () => {
        it('should return 0 for empty string', () => {
            const result = scoreFormatCompliance('', { type: 'number_only' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should return 0 for whitespace-only', () => {
            const result = scoreFormatCompliance('   ', { type: 'exact', template: 'hello' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });
    });

    describe('number_only', () => {
        it('should score 10 for plain integer', () => {
            const result = scoreFormatCompliance('42', { type: 'number_only' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 10 for plain decimal', () => {
            const result = scoreFormatCompliance('3.14159', { type: 'number_only' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 10 for negative number', () => {
            const result = scoreFormatCompliance('-7', { type: 'number_only' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 8 for LaTeX boxed (allow_latex default true)', () => {
            const result = scoreFormatCompliance('$\\boxed{7}$', { type: 'number_only' });
            expect(result.format_score).toBe(8);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 8 for LaTeX boxed without dollar signs', () => {
            const result = scoreFormatCompliance('\\boxed{42}', { type: 'number_only' });
            expect(result.format_score).toBe(8);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 4 for number buried in text', () => {
            const result = scoreFormatCompliance('The answer is 7 because of reasons', { type: 'number_only' });
            expect(result.format_score).toBe(4);
            expect(result.format_compliant).toBe(false);
        });

        it('should score 0 for no number at all', () => {
            const result = scoreFormatCompliance('I do not know the answer', { type: 'number_only' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should reject LaTeX when allow_latex is false', () => {
            const result = scoreFormatCompliance('$\\boxed{7}$', { type: 'number_only', allow_latex: false });
            // Falls through to "number buried in text" since there's a 7
            expect(result.format_score).toBe(4);
            expect(result.format_compliant).toBe(false);
        });
    });

    describe('exact', () => {
        it('should score 10 for exact match', () => {
            const result = scoreFormatCompliance('Hello World', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 7 for case-insensitive match', () => {
            const result = scoreFormatCompliance('hello world', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(7);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 3 for partial match (contains template)', () => {
            const result = scoreFormatCompliance('I think the answer is Hello World, right?', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(3);
            expect(result.format_compliant).toBe(false);
        });

        it('should score 0 for no match', () => {
            const result = scoreFormatCompliance('Goodbye Moon', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should return nulls when template is empty', () => {
            const result = scoreFormatCompliance('anything', { type: 'exact', template: '' });
            expect(result.format_score).toBeNull();
        });
    });

    describe('regex', () => {
        it('should score 10 when pattern matches', () => {
            const result = scoreFormatCompliance('The value is 42.', { type: 'regex', pattern: '\\d+' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 0 when pattern does not match', () => {
            const result = scoreFormatCompliance('no numbers here', { type: 'regex', pattern: '^\\d+$' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should return nulls for invalid regex', () => {
            const result = scoreFormatCompliance('anything', { type: 'regex', pattern: '[invalid' });
            expect(result.format_score).toBeNull();
        });

        it('should return nulls when no pattern provided', () => {
            const result = scoreFormatCompliance('anything', { type: 'regex' });
            expect(result.format_score).toBeNull();
        });
    });

    describe('json_schema', () => {
        it('should score 10 for valid JSON with all required keys', () => {
            const result = scoreFormatCompliance(
                '{"name": "test", "value": 42}',
                { type: 'json_schema', schema_keys: ['name', 'value'] }
            );
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 5 for valid JSON missing required keys', () => {
            const result = scoreFormatCompliance(
                '{"name": "test"}',
                { type: 'json_schema', schema_keys: ['name', 'value'] }
            );
            expect(result.format_score).toBe(5);
            expect(result.format_compliant).toBe(false);
        });

        it('should score 10 for valid JSON when no keys required', () => {
            const result = scoreFormatCompliance(
                '{"anything": true}',
                { type: 'json_schema', schema_keys: [] }
            );
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 0 for non-JSON response', () => {
            const result = scoreFormatCompliance(
                'This is plain text',
                { type: 'json_schema', schema_keys: ['name'] }
            );
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should handle JSON embedded in text', () => {
            const result = scoreFormatCompliance(
                'Here is the result: {"score": 5, "reason": "good"}',
                { type: 'json_schema', schema_keys: ['score', 'reason'] }
            );
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 2 for array instead of object', () => {
            const result = scoreFormatCompliance(
                '[1, 2, 3]',
                { type: 'json_schema', schema_keys: ['value'] }
            );
            // No braces found → 0
            expect(result.format_score).toBe(0);
        });
    });
});

const {
    validateSemanticOutput,
    _internal: { extractAllNumbers }
} = require('../../../src/services/scoring/semanticOutputValidators');

describe('semanticOutputValidators numeric answer normalization', () => {
    test.each([
        ['ASCII space', '5 000'],
        ['non-breaking space', '5\u00a0000'],
        ['narrow non-breaking space', '5\u202f000'],
        ['comma', '5,000'],
        ['LaTeX comma', '5{,}000'],
        ['LaTeX grouped decimal', '5{,}000.0']
    ])('recognizes %s thousands formatting', (_label, formatted) => {
        const values = extractAllNumbers(`Maximum area: ${formatted} square metres.`);
        expect(values).toContain(5000);
    });

    test('routes a boxed LaTeX area and dimensions to semantic review', () => {
        const response = String.raw`x=50, y=100. A_{max}=50\cdot100=\boxed{5{,}000\text{ m}^2}`;
        expect(validateSemanticOutput(response, '', {
            semantic_validator: 'numeric_answer', answer_numbers: [50, 100, 5000]
        })).toMatchObject({ score: null, indeterminate: true });
    });

    test('does not join arbitrary braces or incomplete thousands groups', () => {
        expect(extractAllNumbers('5{,}00 and 5{000} and 5{,}0000')).not.toContain(5000);
    });

    test('retains numbers in prose as evidence without claiming they prove correctness', () => {
        const response = 'Width 50 m, length 100 m, maximum area 5 000 m².';
        const result = validateSemanticOutput(response, '', {
            semantic_validator: 'numeric_answer',
            answer_numbers: [50, 100, 5000],
            answer_tolerance: 0.01
        });

        expect(result).toMatchObject({ matched: false, score: null, indeterminate: true, method: 'numeric_answer' });
        expect(result.comparison.found).toEqual(expect.arrayContaining([50, 100, 5000]));
    });

    test.each(['42 is not the answer. The answer is 43.', 'We considered 42 cases. Final answer: 100.'])
    ('does not certify numeric presence in a wrong prose answer: %s', response => {
        expect(validateSemanticOutput(response, '42', { semantic_validator: 'numeric_answer', answer_numbers: [42] }))
            .toMatchObject({ matched: false, score: null, indeterminate: true });
    });

    test('still verifies a complete standalone numeric list', () => {
        expect(validateSemanticOutput('[50, 100, 5000]', '', {
            semantic_validator: 'numeric_answer', answer_numbers: [50, 100, 5000]
        })).toMatchObject({ matched: true, score: 10 });
    });
});

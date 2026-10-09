'use strict';

const { validateReferenceTests } = require('../../src/services/scoring/referenceTests');
const catalog = require('../../data/benchmark-prompts.json');
const calibration = require('../../data/judge-calibration-set.json');

const FIXTURED_PROMPTS = [
    'Array Sum Function',
    'Palindrome Check Function',
    'Recursive Fibonacci',
    'Extract Shared Helper',
    'Off-by-One Loop Fix',
    'Split Monolithic Function',
    'Dependency Injection Refactor',
    'Count Words Function',
    'Arithmetic Expression Evaluator',
    'Build Order With Cycle Detection',
    ...Object.keys(require('../fixtures/pairedCatalogSolutions.json'))
];

describe('authored reference tests', () => {
    test('every fixture in the prompt catalog is valid and sits on a coding prompt', () => {
        const withFixture = catalog.filter((item) => item.reference_tests !== undefined);
        expect(withFixture.map((item) => item.name).sort()).toEqual([...FIXTURED_PROMPTS].sort());
        for (const item of withFixture) {
            const { valid, errors } = validateReferenceTests(item.reference_tests);
            expect({ name: item.name, valid, errors }).toEqual({ name: item.name, valid: true, errors: [] });
            expect(item.category).toBe('coding');
        }
    });

    test('a fixtured catalog prompt names the language and the entry point it tests', () => {
        for (const item of catalog.filter((entry) => entry.reference_tests !== undefined)) {
            const { value } = validateReferenceTests(item.reference_tests);
            const language = value.language === 'python' ? 'Python' : 'JavaScript';
            expect({ name: item.name, mentions: item.prompt.includes(language) }).toEqual({ name: item.name, mentions: true });
            if (value.entry) {
                expect({ name: item.name, names_entry: item.prompt.includes(value.entry) }).toEqual({ name: item.name, names_entry: true });
            }
        }
    });

    test('every coding calibration item without a reference answer carries a valid fixture its expected answer defines', () => {
        // A diagnosis item mirrors the catalog's coding prompts without tests: it is
        // graded against its reference answer instead (reference scorer).
        const coding = calibration.filter((item) => item.category === 'coding' && !item.reference_answer);
        expect(coding).toHaveLength(4);
        expect(calibration.filter((item) => item.category === 'coding' && item.reference_answer)
            .every((item) => item.reference_tests === undefined)).toBe(true);
        for (const item of coding) {
            const { valid, errors, value } = validateReferenceTests(item.reference_tests);
            expect({ id: item.id, valid, errors }).toEqual({ id: item.id, valid: true, errors: [] });
            expect(item.expected_answer).toContain(`def ${value.entry}(`);
        }
    });

    test('a fixture only reaches items the judge misread: calibration items outside coding carry none', () => {
        for (const item of calibration.filter((entry) => entry.category !== 'coding')) {
            expect(item.reference_tests).toBeUndefined();
        }
    });
});

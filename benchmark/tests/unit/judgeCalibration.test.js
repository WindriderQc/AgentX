'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    calibrationPrompt,
    loadCalibrationSet,
    validateCalibrationSet,
    evaluateCalibrationCase,
    summarizeCalibrationResults,
    summarizeAccuracyCalibration,
    isAccuracyCalibrationValid,
    isIdentityCase,
    keyingCredit,
    qualificationFailures,
    QUALIFICATION_CRITERIA
} = require('../../src/services/benchmark/judgeCalibration');

const entry = { prompt: '2 + 2?', response: '5', category: 'math', expert_scores: { overall: 0 } };

describe('calibration case prompt', () => {
    const criteria = ['Deadline rendered as avant vendredi'];
    const item = { id: 'case-1', category: 'translation', prompt: 'Translate to French: before Friday',
        expected_answer: 'avant vendredi', reference_answer: 'avant vendredi', judge_criteria: criteria,
        response: 'avant vendredi', gold_score: 10, tier: 'excellent', notes: 'Identity.' };

    test('scores a case with the criteria and reference answer its category carries, and nothing it lacks', () => {
        expect(calibrationPrompt(item)).toEqual({ prompt: item.prompt, category: 'translation', expected_answer: 'avant vendredi',
            reference_answer: 'avant vendredi', judge_criteria: criteria, reference_tests: undefined });
        const { reference_answer, judge_criteria, ...plain } = item;
        expect(Object.keys(calibrationPrompt(plain)).sort()).toEqual(['category', 'expected_answer', 'prompt', 'reference_tests']);
    });

    test('the goldset loader keeps them too', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-')), 'set.json');
        fs.writeFileSync(file, JSON.stringify([item]));
        expect(loadCalibrationSet(file)[0]).toMatchObject({ name: 'config-goldset-case-1', reference_answer: 'avant vendredi', judge_criteria: criteria });
    });
});

describe('calibration score presence', () => {
    test('qualifies on ordering, MAE, identity and probes; agreement and correlation are diagnostics', () => {
        const good = { total: 20, scored: 20, correlation: 0.9, mae: 0.7, agreement_rate: 60,
            ordering: { comparable_pairs: 156, ordered: 130, tied: 10, accuracy: 83, accuracy_ties_half: 86.5 },
            identity: { total: 3, full_marks: 3, failed: [] }, attention: { passed: 18, failed: 0, unknown: 2 } };
        expect(isAccuracyCalibrationValid(good)).toBe(true);
        expect(qualificationFailures({ ...good, scored: 3 })).toEqual(['incomplete']);
        expect(qualificationFailures({ ...good, ordering: { ...good.ordering, accuracy_ties_half: 84.9 } })).toEqual(['ordering']);
        expect(qualificationFailures({ ...good, mae: 1.6 })).toEqual(['mae']);
        expect(qualificationFailures({ ...good, mae: null })).toEqual(['mae']);
        expect(qualificationFailures({ ...good, attention: { passed: 17, failed: 1, unknown: 0 } })).toEqual(['attention']);
        expect(qualificationFailures({ ...good, ordering: undefined })).toEqual(['ordering']);
        // Absolute agreement and correlation no longer decide.
        expect(isAccuracyCalibrationValid({ ...good, agreement_rate: 40, correlation: 0.5 })).toBe(true);
        expect(QUALIFICATION_CRITERIA).toMatchObject({ ordering_ties_half_min: 85, mae_max: 1.5 });
    });

    test('the three 2.15 calibration runs under this rule', () => {
        const run = (mae, ordered, tied) => ({ total: 20, scored: 20, mae,
            ordering: { comparable_pairs: 156, ordered, tied, accuracy: null,
                accuracy_ties_half: Math.round(((ordered + tied / 2) / 156) * 1000) / 10 },
            identity: { total: 3, full_marks: 3, failed: [] }, attention: { passed: 18, failed: 0, unknown: 2 } });
        expect(run(1.09, 129, 16).ordering.accuracy_ties_half).toBe(87.8);   // qwen3.8:27b
        expect(isAccuracyCalibrationValid(run(1.09, 129, 16))).toBe(true);
        expect(run(0.89, 118, 32).ordering.accuracy_ties_half).toBe(85.9);   // gemma4:12b, marginal
        expect(isAccuracyCalibrationValid(run(0.89, 118, 32))).toBe(true);
        expect(run(1.0, 141, 5).ordering.accuracy_ties_half).toBe(92);       // gemma4:e4b
        expect(isAccuracyCalibrationValid(run(1.0, 141, 5))).toBe(true);
    });
    test.each([null, undefined, '', ' ', false, Infinity, -1, 11])('does not turn invalid judge score %p into a matching zero', (quality_score) => {
        const result = evaluateCalibrationCase(entry, { quality_score, needs_review: false });
        expect(result).toMatchObject({ judge_score: null, absolute_error: null, within_tolerance: false });
        expect(summarizeCalibrationResults([result])).toMatchObject({ scored: 0, within_tolerance: 0, mae: null });
    });

    test.each([null, undefined, '', false, Infinity, -1, 11])('rejects invalid reference grade %p', (overall) => {
        expect(() => validateCalibrationSet([{ ...entry, expert_scores: { overall } }])).toThrow('invalid entries');
    });

    test('preserves a real zero and applies the default tolerance when omitted or null', () => {
        expect(evaluateCalibrationCase(entry, { quality_score: 0, needs_review: false }))
            .toMatchObject({ judge_score: 0, absolute_error: 0, within_tolerance: true, tolerance: 1 });
        expect(evaluateCalibrationCase({ ...entry, tolerance: null }, { quality_score: '0.5' }))
            .toMatchObject({ judge_score: 0.5, within_tolerance: true, tolerance: 1 });
        expect(evaluateCalibrationCase({ ...entry, tolerance: 0 }, { quality_score: 0.5 }))
            .toMatchObject({ within_tolerance: false, tolerance: 0 });
    });
});

describe('accuracy calibration summary', () => {
    const row = (id, tier, gold, judge, extra = {}) => ({
        id, tier, gold_score: gold, judge_score: judge, success: judge !== null,
        diff: judge === null ? null : Math.round((judge - gold) * 10) / 10,
        abs_diff: judge === null ? null : Math.round(Math.abs(judge - gold) * 10) / 10,
        scoring_method: 'decomposed', ...extra
    });

    test('keeps the statistics the route used to compute inline', () => {
        const rows = [
            row('a', 'clearly_wrong', 1, 3.7),
            row('b', 'mediocre', 5, 9.6),
            row('c', 'excellent', 10, 10),
            row('d', 'excellent', 10, 8.6, { scoring_method: 'deterministic' }),
            row('e', 'good', 8, null)
        ];
        const summary = summarizeAccuracyCalibration(rows, rows.length);

        // Expected values come from the formulas the route computed inline before
        // this summary was extracted; 2.175 rounds to 2.17 in binary floating point.
        expect(summary).toMatchObject({ total: 5, scored: 4, mae: 2.17, bias: 1.48, correlation: 0.798 });
        // Agreement is a share of every case, including the one that failed to score.
        expect(summary.agreement_rate).toBe(20);
        expect(summary.tier_breakdown.excellent).toEqual({ count: 2, mae: 0.7, bias: -0.7 });
        expect(summary.scoring_methods).toEqual({ decomposed: 3, deterministic: 1 });
    });

    test('needs three scored cases for a correlation and reports none scored honestly', () => {
        expect(summarizeAccuracyCalibration([row('a', 'good', 8, 8), row('b', 'good', 9, 9)], 2).correlation).toBeNull();
        expect(summarizeAccuracyCalibration([row('a', 'good', 8, null)], 1))
            .toMatchObject({ scored: 0, mae: null, bias: null, agreement_rate: 0, correlation: null });
    });
});

describe('identity check', () => {
    const reference = { prompt: 'List exactly 3 fruits.', expected_answer: 'Apple\nBanana\nOrange', category: 'instruction', expert_scores: { overall: 10 } };

    test('recognises a response that is the expected answer, ignoring outer whitespace', () => {
        expect(isIdentityCase({ ...reference, response: '  Apple\nBanana\nOrange\n' })).toBe(true);
        expect(isIdentityCase({ ...reference, response: 'Apple, Banana, Orange' })).toBe(false);
        expect(isIdentityCase({ ...reference, expected_answer: null, response: '' })).toBe(false);
        expect(isIdentityCase({ response: 'x' })).toBe(false);
    });

    test('requires full marks within the case tolerance and says nothing about other cases', () => {
        const identical = { ...reference, response: reference.expected_answer };
        expect(evaluateCalibrationCase(identical, { quality_score: 9 })).toMatchObject({ identity_case: true, identity_full_marks: true });
        expect(evaluateCalibrationCase(identical, { quality_score: 8.6 })).toMatchObject({ identity_case: true, identity_full_marks: false });
        expect(evaluateCalibrationCase({ ...identical, tolerance: 0 }, { quality_score: 9.9 })).toMatchObject({ identity_full_marks: false });
        expect(evaluateCalibrationCase(identical, { quality_score: null })).toMatchObject({ identity_full_marks: false });
        expect(evaluateCalibrationCase(entry, { quality_score: 0 })).toMatchObject({ identity_case: false, identity_full_marks: null });
    });

    test('a marked-down reference answer disqualifies an otherwise passing run', () => {
        const passing = { total: 20, scored: 20, mae: 0.7, ordering: { accuracy_ties_half: 90 } };
        expect(isAccuracyCalibrationValid({ ...passing, identity: { total: 3, full_marks: 3, failed: [] } })).toBe(true);
        expect(isAccuracyCalibrationValid({ ...passing, identity: { total: 3, full_marks: 2, failed: ['cal-good-05'] } })).toBe(false);
        expect(isAccuracyCalibrationValid({ ...passing, identity: { total: 0, full_marks: 0, failed: [] } })).toBe(true);
    });

    test('the summary names the identity cases that lost marks', () => {
        const rows = [
            { id: 'same-1', success: true, judge_score: 10, gold_score: 10, diff: 0, abs_diff: 0, identity_case: true, identity_full_marks: true },
            { id: 'same-2', success: true, judge_score: 8.6, gold_score: 10, diff: -1.4, abs_diff: 1.4, identity_case: true, identity_full_marks: false },
            { id: 'other', success: true, judge_score: 4, gold_score: 5, diff: -1, abs_diff: 1, identity_case: false, identity_full_marks: null }
        ];
        expect(summarizeAccuracyCalibration(rows, 3).identity).toEqual({ total: 2, full_marks: 1, failed: ['same-2'] });
    });
});

describe('keying bias diagnostic', () => {
    const q = (answer, inverted) => ({ question: 'q', answer, weight: 0.25, inverted, contributed: answer === null ? false : answer !== inverted });

    test('credits a negatively keyed question for NO and ignores errored calls', () => {
        expect(keyingCredit({ accuracy: [q(true, false), q(false, false)], logic: [q(true, true), q(false, true), q(null, true)] }))
            .toEqual({ positive: { asked: 2, credited: 1 }, negative: { asked: 2, credited: 1 } });
        expect(keyingCredit(null)).toBeNull();
        expect(keyingCredit({ overall: 2 })).toBeNull();
    });

    test('reports how much a strong answer loses to negative phrasing alone', () => {
        const keying = (pAsked, pCredited, nAsked, nCredited) => ({
            positive: { asked: pAsked, credited: pCredited }, negative: { asked: nAsked, credited: nCredited }
        });
        const base = { success: true, diff: 0, abs_diff: 0, tier: 't' };
        const rows = [
            { ...base, id: 's1', gold_score: 10, judge_score: 10, keying: keying(10, 9, 2, 1) },
            { ...base, id: 's2', gold_score: 8, judge_score: 8, keying: keying(10, 9, 2, 1) },
            { ...base, id: 'w1', gold_score: 1, judge_score: 1, keying: keying(10, 2, 2, 0) },
            { ...base, id: 'mid', gold_score: 5, judge_score: 5, keying: keying(10, 5, 2, 1) },
            { ...base, id: 'det', gold_score: 10, judge_score: 10, keying: null }
        ];
        const { keying_bias: bias } = summarizeAccuracyCalibration(rows, rows.length);

        expect(bias.strong.positive).toEqual({ asked: 20, credited: 18, credit_rate: 90 });
        expect(bias.strong.negative).toEqual({ asked: 4, credited: 2, credit_rate: 50 });
        expect(bias.strong.gap).toBe(40);
        expect(bias.weak.gap).toBe(20);
    });

    test('has no gap to report when a band asked no negatively keyed question', () => {
        const rows = [{ id: 'a', success: true, gold_score: 10, judge_score: 10, diff: 0, abs_diff: 0, tier: 't',
            keying: { positive: { asked: 4, credited: 4 }, negative: { asked: 0, credited: 0 } } }];
        expect(summarizeAccuracyCalibration(rows, 1).keying_bias.strong)
            .toMatchObject({ negative: { credit_rate: null }, gap: null });
    });
});

describe('ordering accuracy', () => {
    const row = (id, gold, judge) => ({ id, tier: 't', gold_score: gold, judge_score: judge, success: true,
        diff: judge - gold, abs_diff: Math.abs(judge - gold), scoring_method: 'decomposed' });

    test('counts pairs with different references that the judge orders the same way, ties apart', () => {
        const summary = summarizeAccuracyCalibration([row('a', 1, 2), row('b', 5, 5), row('c', 10, 5), row('d', 5, 4)], 4);
        // Pairs with different gold: a-b, a-c, a-d, b-c, c-d (b-d share gold 5).
        // The judge ties b-c (5 vs 5) and orders the other four correctly.
        expect(summary.ordering).toEqual({ comparable_pairs: 5, ordered: 4, tied: 1, accuracy: 80, accuracy_ties_half: 90 });
    });

    test('reports no accuracy when nothing is comparable', () => {
        expect(summarizeAccuracyCalibration([row('a', 5, 5), row('b', 5, 6)], 2).ordering)
            .toEqual({ comparable_pairs: 0, ordered: 0, tied: 0, accuracy: null, accuracy_ties_half: null });
    });
});

describe('attention-probe summary', () => {
    test('counts passed, failed and unknown probes over scored cases', () => {
        const base = { success: true, tier: 't', diff: 0, abs_diff: 0, gold_score: 8, judge_score: 8 };
        const rows = [
            { ...base, id: 'a', attention_check: { passed: true, probes: [] } },
            { ...base, id: 'b', attention_check: { passed: false, probes: [] } },
            { ...base, id: 'c', attention_check: { passed: null, probes: [] } },
            { ...base, id: 'd' }
        ];
        expect(summarizeAccuracyCalibration(rows, 4).attention).toEqual({ passed: 1, failed: 1, unknown: 2 });
    });
});

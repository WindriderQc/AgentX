'use strict';
/**
 * Thinking mode (response_mode best_qualified): thinking from L4 where the
 * artifact/host profile qualifies it, final answers otherwise; ranked; its
 * own quality cohort; shown as "Thinking mode" on the leaderboard.
 */

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { normalizeExecutionConfig } = require('../../../src/services/benchmark/config');
const { MODES, normalizeResponseMode, resolveFrozenMode, promptExecConfig } = require('../../../src/services/benchmark/inferenceContractSnapshot');
const { buildQualityCohortFingerprint } = require('../../../../shared/benchmarkTargetContract');
const { loadLeaderboardTextModules, loadBrowserModule } = require('../../helpers/browserModule');

const contract = (thinking) => ({
    qualification: { qualified: true },
    capabilities: {
        thinking: {
            supported: thinking,
            modes: thinking ? ['off', 'on'] : ['off'],
            visibleFinalAnswer: { qualified: thinking }
        }
    }
});

describe('thinking mode configuration', () => {
    test('the launch form value selects thinking mode from L4', () => {
        const config = normalizeExecutionConfig({ think: 'best_qualified' });
        expect(config).toMatchObject({ response_mode: 'best_qualified', think: 'auto', thinking_min_level: 4 });
        expect(normalizeExecutionConfig({ response_mode: 'best_qualified', thinking_min_level: 5 }).thinking_min_level).toBe(5);
        expect(normalizeExecutionConfig({ response_mode: 'best_qualified', thinking_min_level: 9 }).thinking_min_level).toBe(4);
        expect(normalizeResponseMode(config)).toBe(MODES.BEST_QUALIFIED);
    });

    test('other modes are untouched', () => {
        expect(normalizeExecutionConfig({ think: 'auto' })).toMatchObject({ response_mode: 'profile_auto', think: 'auto' });
        expect(normalizeExecutionConfig({ response_mode: 'final_only' }).thinking_min_level).toBeUndefined();
    });
});

describe('thinking mode per model and per prompt', () => {
    const settings = { thinking_min_level: 4 };

    test('ranks either way; thinks only where the profile qualifies thinking', () => {
        expect(resolveFrozenMode(contract(true), { response_mode: 'best_qualified', ...settings }))
            .toMatchObject({ name: 'best_qualified', think: true, thinkMinLevel: 4, rankable: true });
        expect(resolveFrozenMode(contract(false), { response_mode: 'best_qualified', ...settings }))
            .toMatchObject({ name: 'best_qualified', think: false, rankable: true });
    });

    test('a qualified model thinks from L4, answers directly below', () => {
        const model = { think: true, think_mode: 'best_qualified', think_min_level: 4, thinking_policy_reason: 'qualified' };
        expect(promptExecConfig(model, { level: 3 })).toMatchObject({ think: false, thinking_policy_reason: 'thinking mode: L3 < L4, thinking off' });
        expect(promptExecConfig(model, { level: 4 })).toMatchObject({ think: true, thinking_policy_reason: 'thinking mode: L4 >= L4, thinking on' });
        expect(promptExecConfig(model, { level: 5 }).think).toBe(true);
    });

    test('an unqualified model never thinks, and other modes are passed through', () => {
        expect(promptExecConfig({ think: false, think_mode: 'best_qualified', think_min_level: 4 }, { level: 5 }).think).toBe(false);
        const explicit = { think: true, think_mode: 'explicit_thinking' };
        expect(promptExecConfig(explicit, { level: 1 })).toBe(explicit);
    });
});

describe('thinking mode cohort', () => {
    const base = { prompts: [{ name: 'p', prompt: 'q', level: 4, category: 'math' }], scorerVersion: '2.17.0', judgeTarget: null };

    test('is its own cohort, apart from profile-driven auto mode', () => {
        const thinking = buildQualityCohortFingerprint({ ...base, executionConfig: normalizeExecutionConfig({ think: 'best_qualified' }) });
        const auto = buildQualityCohortFingerprint({ ...base, executionConfig: normalizeExecutionConfig({ think: 'auto' }) });
        expect(thinking).not.toBe(auto);
    });

    test('leaves existing cohort fingerprints unchanged', () => {
        const finalOnly = normalizeExecutionConfig({ response_mode: 'final_only' });
        expect(buildQualityCohortFingerprint({ ...base, executionConfig: finalOnly }))
            .toBe(buildQualityCohortFingerprint({ ...base, executionConfig: { ...finalOnly, thinking_min_level: 4 } }));
    });
});

describe('thinking mode on the leaderboard', () => {
    const text = loadLeaderboardTextModules();
    const board = loadBrowserModule('leaderboard-v2/combined-board.js', 'renderCombinedBoard', {
        ...text,
        getReadinessMap: async () => ({}), getBadgeHtml: () => '', speedometer: () => '',
        formatMs: () => '—', valColor: () => '#fff', shortHost: () => 'host', scoreColor: () => '#fff'
    });

    test('names the mode in the header and counts the answers with thinking on the row', async () => {
        const container = { innerHTML: '', dataset: {}, querySelector: () => null };
        await board.renderCombinedBoard(container, [{
            model: 'qwen3.8:27b', score: 9.1, verdict: { comparable: true, reasons: [], notes: [] }, judgeModel: 'judge',
            thinking: { mode: 'best_qualified', minLevel: 4, rows: 42 }, resultCount: 105, testCount: 105, categoryScores: {}, dimensions: []
        }]);
        expect(container.innerHTML).toContain('Thinking mode (L4–L5, qualified models) · Judged by judge');
        expect(container.innerHTML).toContain('Thinking mode L4+ · 42/105 answers with thinking');
    });
});

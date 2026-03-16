/**
 * Tests for resolveJudgeConfigForPrompt and hasExplicitJudgeConfigValue
 */

const {
    resolveJudgeConfigForPrompt,
    hasExplicitJudgeConfigValue
} = require('../../src/services/qualityScorer');
const { normalizeJudgeConfigContract } = require('../../src/services/scoring/judgeConfigResolver');

describe('hasExplicitJudgeConfigValue', () => {
    test('returns true when key exists with a real value', () => {
        expect(hasExplicitJudgeConfigValue({ model: 'qwen2.5:7b' }, 'model')).toBe(true);
        expect(hasExplicitJudgeConfigValue({ host: 'http://host:11434' }, 'host')).toBe(true);
    });

    test('returns false for undefined, null, or empty-string values', () => {
        expect(hasExplicitJudgeConfigValue({ model: undefined }, 'model')).toBe(false);
        expect(hasExplicitJudgeConfigValue({ model: null }, 'model')).toBe(false);
        expect(hasExplicitJudgeConfigValue({ model: '' }, 'model')).toBe(false);
    });

    test('returns false when key is absent', () => {
        expect(hasExplicitJudgeConfigValue({}, 'model')).toBe(false);
        expect(hasExplicitJudgeConfigValue(null, 'model')).toBe(false);
        expect(hasExplicitJudgeConfigValue(undefined, 'model')).toBe(false);
    });
});

function makePrompt(level = 5, category = 'general') {
    return { level, prompt_level: level, category, text: 'test prompt' };
}

function makeMergedConfig(overrides = {}) {
    return { model: 'qwen2.5:7b-instruct-q5_K_M', host: 'http://ugfrank:11434', temperature: 0.1, ...overrides };
}

describe('normalizeJudgeConfigContract', () => {
    test('preserves explicit model and host as pinned config', () => {
        const normalized = normalizeJudgeConfigContract({
            model: 'qwen2.5:7b-instruct-q5_K_M',
            host: 'http://ugfrank:11434',
            num_ctx: 16384
        });

        expect(normalized.mode).toBe('pinned');
        expect(normalized.model).toBe('qwen2.5:7b-instruct-q5_K_M');
        expect(normalized.host).toBe('http://ugfrank:11434');
        expect(normalized.num_ctx).toBe(16384);
        expect(normalized.judge_same_host).toBeUndefined();
        expect(normalized.judge_tier_auto_upgrade).toBeUndefined();
    });
});

describe('resolveJudgeConfigForPrompt — pinned only', () => {
    test('applies explicit pinned host and model to the merged config', async () => {
        const rawJudgeConfig = {
            model: 'qwen2.5:14b-instruct',
            host: 'http://ugbrutal:11434'
        };
        const result = await resolveJudgeConfigForPrompt(makePrompt(8), makeMergedConfig(), rawJudgeConfig);

        expect(result.mergedJudgeConfig.model).toBe('qwen2.5:14b-instruct');
        expect(result.mergedJudgeConfig.host).toBe('http://ugbrutal:11434');
        expect(result.judgeTierMeta.mode).toBe('pinned');
        expect(result.judgeTierMeta.required_tier).toBe('advanced');
        expect(result.judgeTierMeta.tier).toBe('advanced');
    });

    test('keeps the merged config when no override is provided', async () => {
        const mergedConfig = makeMergedConfig();
        const result = await resolveJudgeConfigForPrompt(makePrompt(5), { ...mergedConfig }, {});

        expect(result.mergedJudgeConfig.model).toBe(mergedConfig.model);
        expect(result.mergedJudgeConfig.host).toBe(mergedConfig.host);
        expect(result.judgeTierMeta.tier).toBe('standard');
    });

    test('does not mutate rawJudgeConfig', async () => {
        const frozen = Object.freeze({
            model: 'qwen2.5:14b-instruct',
            host: 'http://ugbrutal:11434'
        });

        await expect(resolveJudgeConfigForPrompt(makePrompt(8), makeMergedConfig(), frozen)).resolves.toBeTruthy();
    });
});

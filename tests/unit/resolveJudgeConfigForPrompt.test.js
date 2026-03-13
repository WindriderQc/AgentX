/**
 * Tests for resolveJudgeConfigForPrompt and hasExplicitJudgeConfigValue
 *
 * Covers:
 *   - Pinned mode semantics
 *   - Legacy auto-upgrade compatibility mapping
 *   - Tier resolution path for auto mode
 *   - Stale host is never injected by the resolver
 *   - No mutation of the original rawJudgeConfig
 */

const {
    resolveJudgeConfigForPrompt,
    hasExplicitJudgeConfigValue,
    JUDGE_CONFIG
} = require('../../src/services/qualityScorer');
const { normalizeJudgeConfigContract } = require('../../src/services/scoring/judgeConfigResolver');

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Mock ModelRegistry so getJudgeCandidatesCached returns controllable data
// Must return a chainable query: .find().select().lean()
const mockFindChain = { select: jest.fn(), lean: jest.fn() };
jest.mock('../../models/ModelRegistry', () => ({
    find: jest.fn(() => mockFindChain)
}));

const ModelRegistry = require('../../models/ModelRegistry');
const { _clearJudgeCandidateCache } = require('../../src/services/qualityScorer');

// ---------------------------------------------------------------------------
// hasExplicitJudgeConfigValue
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// resolveJudgeConfigForPrompt – helpers
// ---------------------------------------------------------------------------

function makePrompt(level = 5, category = 'general') {
    return { level, prompt_level: level, category, text: 'test prompt' };
}

function makeMergedConfig(overrides = {}) {
    return { model: 'qwen2.5:7b-instruct-q5_K_M', host: 'http://ugfrank:11434', temperature: 0.1, ...overrides };
}

function makeJudgeCandidate(modelName, host, judgeTier, reliability = 0.9, avgJudgeLatencyMs = 3000) {
    return {
        modelName,
        host,
        capabilities: { judgeTier, judgeReliability: reliability, avgJudgeLatencyMs }
    };
}

// ---------------------------------------------------------------------------
// resolveJudgeConfigForPrompt – explicit model guard
// ---------------------------------------------------------------------------
describe('resolveJudgeConfigForPrompt — pinned mode semantics', () => {
    beforeEach(() => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([
            makeJudgeCandidate('qwen2.5:14b-instruct', 'http://ugbrutal:11434', 'advanced')
        ]);
        mockFindChain.select.mockReturnValue(mockFindChain);
    });

    test('legacy explicit model remains pinned when auto-upgrade is not enabled', async () => {
        const rawJudgeConfig = { model: 'qwen2.5:7b-instruct-q5_K_M' };
        const mergedConfig = makeMergedConfig();
        const prompt = makePrompt(8); // level 8 would normally need 'advanced'

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        // Model must NOT be changed — user explicitly chose 7b
        expect(result.mergedJudgeConfig.model).toBe('qwen2.5:7b-instruct-q5_K_M');
        // Registry should NOT have been queried
        expect(ModelRegistry.find).not.toHaveBeenCalled();
    });

    test('pinned mode prevents host override', async () => {
        const rawJudgeConfig = { mode: 'pinned', pinnedModel: 'qwen2.5:7b-instruct-q5_K_M', pinnedHost: 'http://ugfrank:11434' };
        const mergedConfig = makeMergedConfig({ host: 'http://ugfrank:11434' });
        const prompt = makePrompt(9); // premium level

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        expect(result.mergedJudgeConfig.host).toBe('http://ugfrank:11434');
        expect(ModelRegistry.find).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// normalizeJudgeConfigContract
// ---------------------------------------------------------------------------
describe('normalizeJudgeConfigContract', () => {
    test('adds legacy compatibility aliases for canonical pinned mode', () => {
        const normalized = normalizeJudgeConfigContract({
            mode: 'pinned',
            pinnedModel: 'qwen2.5:14b-instruct',
            pinnedHost: 'http://ugbrutal:11434'
        });

        expect(normalized.mode).toBe('pinned');
        expect(normalized.model).toBe('qwen2.5:14b-instruct');
        expect(normalized.host).toBe('http://ugbrutal:11434');
        expect(normalized.judge_tier_auto_upgrade).toBe(false);
    });

    test('keeps remembered legacy model in auto mode without converting it to pinned', () => {
        const normalized = normalizeJudgeConfigContract({
            mode: 'auto',
            model: 'qwen2.5:7b-instruct-q5_K_M',
            host: 'http://ugfrank:11434'
        });

        expect(normalized.mode).toBe('auto');
        expect(normalized.pinnedModel).toBeUndefined();
        expect(normalized.pinnedHost).toBeUndefined();
        expect(normalized.judge_tier_auto_upgrade).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// resolveJudgeConfigForPrompt — auto-upgrade OFF (default)
// ---------------------------------------------------------------------------
describe('resolveJudgeConfigForPrompt — auto-upgrade OFF (default)', () => {
    beforeEach(() => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([
            makeJudgeCandidate('qwen2.5:14b-instruct', 'http://ugbrutal:11434', 'advanced', 0.95)
        ]);
        mockFindChain.select.mockReturnValue(mockFindChain);
        ModelRegistry.find.mockClear();
    });

    test('does NOT upgrade model when judge_tier_auto_upgrade is absent', async () => {
        const rawJudgeConfig = {}; // no explicit model, no auto-upgrade flag
        const mergedConfig = makeMergedConfig();
        const prompt = makePrompt(8); // would normally trigger advanced tier

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        expect(result.mergedJudgeConfig.model).toBe(mergedConfig.model);
        expect(ModelRegistry.find).not.toHaveBeenCalled();
    });

    test('does NOT upgrade model when judge_tier_auto_upgrade is explicitly false', async () => {
        const rawJudgeConfig = { judge_tier_auto_upgrade: false };
        const mergedConfig = makeMergedConfig();
        const prompt = makePrompt(10); // premium level

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        expect(result.mergedJudgeConfig.model).toBe(mergedConfig.model);
        expect(ModelRegistry.find).not.toHaveBeenCalled();
    });

    test('returns correct judgeTierMeta reflecting the static model tier', async () => {
        const rawJudgeConfig = {};
        // 7b model → standard tier via inferJudgeTier
        const mergedConfig = makeMergedConfig();
        const prompt = makePrompt(7);

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        expect(result.judgeTierMeta.tier_downgraded).toBe(false);
        // tier inferred from '7b' in model name
        expect(result.judgeTierMeta.tier).toBe('standard');
    });
});

// ---------------------------------------------------------------------------
// resolveJudgeConfigForPrompt — auto-upgrade ON, no explicit model
// ---------------------------------------------------------------------------
describe('resolveJudgeConfigForPrompt — auto mode', () => {
    test('upgrades to advanced-tier candidate for level 8 prompt', async () => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([
            makeJudgeCandidate('qwen2.5:14b-instruct', 'http://ugbrutal:11434', 'advanced', 0.95)
        ]);
        mockFindChain.select.mockReturnValue(mockFindChain);

        const rawJudgeConfig = { mode: 'auto' };
        const mergedConfig = makeMergedConfig();
        const prompt = makePrompt(8);

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        expect(result.mergedJudgeConfig.model).toBe('qwen2.5:14b-instruct');
        expect(result.mergedJudgeConfig.host).toBe('http://ugbrutal:11434');
        expect(result.judgeTierMeta.tier).toBe('advanced');
        expect(result.judgeTierMeta.tier_downgraded).toBe(false);
    });

    test('downgrades gracefully when required tier is unavailable', async () => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([
            makeJudgeCandidate('qwen2.5:7b-instruct', 'http://ugfrank:11434', 'standard', 0.9)
        ]);
        mockFindChain.select.mockReturnValue(mockFindChain);
        // Only a standard-tier candidate available but prompt needs premium

        const rawJudgeConfig = { judge_tier_auto_upgrade: true };
        const mergedConfig = makeMergedConfig();
        const prompt = makePrompt(10); // advanced required

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        // Took the best available (standard), flagged as downgraded
        expect(result.judgeTierMeta.tier_downgraded).toBe(true);
        expect(result.judgeTierMeta.required_tier).toBe('advanced');
    });

    test('returns default meta when no candidates in registry', async () => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([]);
        mockFindChain.select.mockReturnValue(mockFindChain);

        const rawJudgeConfig = { judge_tier_auto_upgrade: true };
        const originalModel = 'qwen2.5:7b-instruct-q5_K_M';
        const mergedConfig = makeMergedConfig({ model: originalModel });
        const prompt = makePrompt(9);

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        // Falls back gracefully without changing model
        expect(result.mergedJudgeConfig.model).toBe(originalModel);
        expect(result.judgeTierMeta.tier_downgraded).toBe(false);
    });

    test('does not mutate rawJudgeConfig', async () => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([
            makeJudgeCandidate('qwen2.5:14b-instruct', 'http://ugbrutal:11434', 'advanced')
        ]);
        mockFindChain.select.mockReturnValue(mockFindChain);

        const rawJudgeConfig = { judge_tier_auto_upgrade: true };
        const frozen = Object.freeze({ ...rawJudgeConfig }); // will throw on mutation

        await expect(
            resolveJudgeConfigForPrompt(makePrompt(8), makeMergedConfig(), frozen)
        ).resolves.not.toThrow();
    });

    test('treats remembered legacy model as a starting point, not a pinned selection, in auto mode', async () => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([
            makeJudgeCandidate('qwen2.5:14b-instruct', 'http://ugfrank:11434', 'advanced', 0.95)
        ]);
        mockFindChain.select.mockReturnValue(mockFindChain);

        const rawJudgeConfig = {
            mode: 'auto',
            model: 'qwen2.5:7b-instruct-q5_K_M',
            host: 'http://ugfrank:11434'
        };
        const mergedConfig = makeMergedConfig({
            model: 'qwen2.5:7b-instruct-q5_K_M',
            host: 'http://ugfrank:11434'
        });

        const result = await resolveJudgeConfigForPrompt(makePrompt(8), { ...mergedConfig }, rawJudgeConfig);

        expect(result.mergedJudgeConfig.model).toBe('qwen2.5:14b-instruct');
        expect(result.mergedJudgeConfig.host).toBe('http://ugfrank:11434');
        expect(result.judgeTierMeta.tier).toBe('advanced');
    });
});

// ---------------------------------------------------------------------------
// resolveJudgeConfigForPrompt — preferred_tier override
// ---------------------------------------------------------------------------
describe('resolveJudgeConfigForPrompt — preferred_tier override', () => {
    test('uses preferred_tier from rawJudgeConfig over prompt-level-derived tier', async () => {
        _clearJudgeCandidateCache();
        mockFindChain.lean.mockResolvedValue([
            makeJudgeCandidate('qwen2.5:7b-instruct', 'http://ugfrank:11434', 'standard', 0.9),
            makeJudgeCandidate('qwen2.5:14b-instruct', 'http://ugbrutal:11434', 'advanced', 0.95)
        ]);
        mockFindChain.select.mockReturnValue(mockFindChain);

        const rawJudgeConfig = { judge_tier_auto_upgrade: true, preferred_tier: 'standard' };
        const mergedConfig = makeMergedConfig();
        const prompt = makePrompt(8); // would normally need advanced

        const result = await resolveJudgeConfigForPrompt(prompt, { ...mergedConfig }, rawJudgeConfig);

        // preferred_tier=standard overrides the prompt-level mapping
        expect(result.judgeTierMeta.required_tier).toBe('standard');
    });
});

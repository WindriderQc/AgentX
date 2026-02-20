/**
 * Tests for judgeTierResolver – judge tier mapping, model selection, and presets
 */

const {
  TIER_RANK,
  LEVEL_TIER_MAP,
  JUDGE_PRESETS,
  getRequiredTier,
  tierMeetsRequirement,
  resolveJudgeModel,
  inferJudgeTier,
  getJudgePreset
} = require('../../src/services/scoring/judgeTierResolver');

// ---------------------------------------------------------------------------
// Constants / structure validation
// ---------------------------------------------------------------------------
describe('judgeTierResolver constants', () => {
  test('TIER_RANK covers all four tiers in ascending order', () => {
    expect(TIER_RANK.basic).toBe(1);
    expect(TIER_RANK.standard).toBe(2);
    expect(TIER_RANK.advanced).toBe(3);
    expect(TIER_RANK.premium).toBe(4);
  });

  test('LEVEL_TIER_MAP covers levels 1-10', () => {
    for (let l = 1; l <= 10; l++) {
      expect(LEVEL_TIER_MAP[l]).toBeDefined();
    }
  });

  test('JUDGE_PRESETS contains fast, balanced, precise, premium', () => {
    ['fast', 'balanced', 'precise', 'premium'].forEach(name => {
      expect(JUDGE_PRESETS[name]).toBeDefined();
      expect(JUDGE_PRESETS[name]).toHaveProperty('minTier');
      expect(JUDGE_PRESETS[name]).toHaveProperty('timeout');
    });
  });
});

// ---------------------------------------------------------------------------
// getRequiredTier
// ---------------------------------------------------------------------------
describe('getRequiredTier', () => {
  test.each([
    [1, 'basic'], [2, 'basic'], [3, 'basic'],
    [4, 'standard'], [5, 'standard'], [6, 'standard'],
    [7, 'advanced'], [8, 'advanced'],
    [9, 'premium'], [10, 'premium']
  ])('level %i → %s', (level, expected) => {
    expect(getRequiredTier(level)).toBe(expected);
  });

  test('clamps out-of-range levels to valid range', () => {
    // 0 is falsy -> defaults to 5 -> standard
    expect(getRequiredTier(0)).toBe('standard');
    // 11 clamps to 10 -> premium
    expect(getRequiredTier(11)).toBe('premium');
    // -1 is truthy -> clamps to max(1,-1)=1 -> basic
    expect(getRequiredTier(-1)).toBe('basic');
    // undefined/null -> default 5 -> standard
    expect(getRequiredTier(undefined)).toBe('standard');
    expect(getRequiredTier(null)).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// tierMeetsRequirement
// ---------------------------------------------------------------------------
describe('tierMeetsRequirement', () => {
  test('same tier meets requirement', () => {
    expect(tierMeetsRequirement('standard', 'standard')).toBe(true);
  });

  test('higher tier meets lower requirement', () => {
    expect(tierMeetsRequirement('advanced', 'standard')).toBe(true);
    expect(tierMeetsRequirement('premium', 'basic')).toBe(true);
  });

  test('lower tier does NOT meet higher requirement', () => {
    expect(tierMeetsRequirement('basic', 'standard')).toBe(false);
    expect(tierMeetsRequirement('standard', 'premium')).toBe(false);
  });

  test('null / unknown tier returns false', () => {
    expect(tierMeetsRequirement(null, 'standard')).toBe(false);
    expect(tierMeetsRequirement(undefined, 'basic')).toBe(false);
  });

  test('null / undefined requirement → true (no requirement)', () => {
    expect(tierMeetsRequirement('basic', null)).toBe(true);
    expect(tierMeetsRequirement('standard', undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inferJudgeTier (heuristic from model name)
// ---------------------------------------------------------------------------
describe('inferJudgeTier', () => {
  test('large models (≥65B) → premium', () => {
    expect(inferJudgeTier('llama3:70b-instruct')).toBe('premium');
    expect(inferJudgeTier('qwen2.5:72b')).toBe('premium');
  });

  test('medium-large models (≥12B) → advanced', () => {
    expect(inferJudgeTier('qwen2.5:14b-instruct-q4_K_M')).toBe('advanced');
    expect(inferJudgeTier('codellama:13b')).toBe('advanced');
  });

  test('medium models (≥5B) → standard', () => {
    expect(inferJudgeTier('qwen2.5:7b-instruct-q5_K_M')).toBe('standard');
    expect(inferJudgeTier('llama3.1:8b')).toBe('standard');
  });

  test('small models (≥1B, <5B) → basic', () => {
    expect(inferJudgeTier('phi3:3.8b')).toBe('basic');
    expect(inferJudgeTier('gemma:2b')).toBe('basic');
    expect(inferJudgeTier('tinyllama:1.1b')).toBe('basic');
  });

  test('returns null for unparseable model names', () => {
    expect(inferJudgeTier('some-model')).toBeNull();
    expect(inferJudgeTier('')).toBeNull();
    expect(inferJudgeTier(null)).toBeNull();
    expect(inferJudgeTier(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveJudgeModel
// ---------------------------------------------------------------------------
describe('resolveJudgeModel', () => {
  const candidates = [
    {
      modelName: 'qwen2.5:7b-instruct-q5_K_M',
      capabilities: { judgeTier: 'standard', judgeReliability: 0.95 },
      host: 'host-a'
    },
    {
      modelName: 'llama3.1:8b',
      capabilities: { judgeTier: 'standard', judgeReliability: 0.97 },
      host: 'host-b'
    },
    {
      modelName: 'qwen2.5:14b-instruct-q4_K_M',
      capabilities: { judgeTier: 'advanced', judgeReliability: 0.90 },
      host: 'host-a'
    }
  ];

  test('picks best candidate for "standard" requirement', () => {
    const result = resolveJudgeModel(candidates, { preferredTier: 'standard' });
    expect(result).toBeDefined();
    expect(result.model).toBeDefined();
    expect(result.tier).toBeDefined();
    expect(result.tier_downgraded).toBe(false);
  });

  test('returns tier_downgraded=true when no candidate meets required tier', () => {
    const basicOnly = [
      { modelName: 'tiny:1b', capabilities: { judgeTier: 'basic', judgeReliability: 0.50 }, host: 'h1' }
    ];
    const result = resolveJudgeModel(basicOnly, { preferredTier: 'advanced' });
    expect(result.tier_downgraded).toBe(true);
    expect(result.model).toBe('tiny:1b');
  });

  test('returns {model:null} for empty candidates array', () => {
    const result = resolveJudgeModel([], { preferredTier: 'standard' });
    expect(result.model).toBeNull();
    expect(result.warning).toBeDefined();
  });

  test('returns {model:null} for undefined candidates', () => {
    const result = resolveJudgeModel(undefined);
    expect(result.model).toBeNull();
    expect(result.warning).toBeDefined();
  });

  test('prefers candidate on preferredHost', () => {
    const result = resolveJudgeModel(candidates, {
      preferredTier: 'standard',
      preferredHost: 'host-b'
    });
    // llama3.1:8b is on host-b with higher reliability, should be chosen
    expect(result.model).toBe('llama3.1:8b');
  });

  test('picks advanced model when advanced tier required', () => {
    const result = resolveJudgeModel(candidates, { preferredTier: 'advanced' });
    expect(result.model).toBe('qwen2.5:14b-instruct-q4_K_M');
    expect(result.tier).toBe('advanced');
    expect(result.tier_downgraded).toBe(false);
  });

  test('falls back to unknown tier when capabilities.judgeTier missing', () => {
    const noTierCandidates = [
      { modelName: 'qwen2.5:7b-instruct', capabilities: {}, host: 'h1' }
    ];
    const result = resolveJudgeModel(noTierCandidates, { preferredTier: 'standard' });
    expect(result).toBeDefined();
    // No candidates pass the judgeTier filter → fallback with 'unknown' tier
    expect(result.tier).toBe('unknown');
    expect(result.tier_downgraded).toBe(true);
    expect(result.model).toBe('qwen2.5:7b-instruct');
  });
});

// ---------------------------------------------------------------------------
// getJudgePreset
// ---------------------------------------------------------------------------
describe('getJudgePreset', () => {
  test('returns preset for known names', () => {
    const fast = getJudgePreset('fast');
    expect(fast).toHaveProperty('minTier');
    expect(fast).toHaveProperty('timeout');
    expect(fast.minTier).toBe('basic');

    const premium = getJudgePreset('premium');
    expect(premium.minTier).toBe('premium');
  });

  test('returns null for unknown preset', () => {
    expect(getJudgePreset('ultra')).toBeNull();
    expect(getJudgePreset(undefined)).toBeNull();
    expect(getJudgePreset('')).toBeNull();
  });
});

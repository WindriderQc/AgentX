/**
 * Tests for judgeTierResolver – judge tier mapping, model selection, and presets
 */

const {
  TIER_RANK,
  LEVEL_TIER_MAP,
  JUDGE_PRESETS,
  getRequiredTier,
  tierMeetsRequirement,
  inferJudgeTier,
  resolveJudgeTierMetadata,
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

  test('LEVEL_TIER_MAP covers levels 1-5', () => {
    for (let l = 1; l <= 5; l++) {
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
    [1, 'basic'],
    [2, 'standard'], [3, 'standard'],
    [4, 'advanced'], [5, 'advanced']
  ])('level %i → %s', (level, expected) => {
    expect(getRequiredTier(level)).toBe(expected);
  });

  test('clamps out-of-range levels to valid range', () => {
    // 0 is falsy -> defaults to 3 -> standard
    expect(getRequiredTier(0)).toBe('standard');
    // 11 clamps to 5 -> advanced
    expect(getRequiredTier(11)).toBe('advanced');
    // -1 is truthy -> clamps to max(1,-1)=1 -> basic
    expect(getRequiredTier(-1)).toBe('basic');
    // undefined/null -> default 3 -> standard
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
// resolveJudgeTierMetadata
// ---------------------------------------------------------------------------
describe('resolveJudgeTierMetadata', () => {
  test('prefers curated tier over legacy and calibration metadata', () => {
    const result = resolveJudgeTierMetadata({
      curatedJudgeTier: 'premium',
      judgeTier: 'advanced',
      recommendedJudgeTier: 'standard',
      calibratedJudgeTier: 'basic'
    }, 'qwen2.5:7b');

    expect(result.effectiveTier).toBe('premium');
    expect(result.curatedTier).toBe('premium');
    expect(result.legacyTier).toBe('advanced');
    expect(result.source).toBe('curated');
  });

  test('uses legacy judgeTier before recommended calibration output', () => {
    const result = resolveJudgeTierMetadata({
      judgeTier: 'advanced',
      recommendedJudgeTier: 'standard',
      calibratedJudgeTier: 'basic'
    }, 'qwen2.5:7b');

    expect(result.effectiveTier).toBe('advanced');
    expect(result.legacyTier).toBe('advanced');
    expect(result.source).toBe('legacy');
  });

  test('falls back to recommended or calibrated tier when no curated metadata exists', () => {
    const recommended = resolveJudgeTierMetadata({
      recommendedJudgeTier: 'advanced',
      calibratedJudgeTier: 'standard'
    }, 'qwen2.5:7b');
    const calibrated = resolveJudgeTierMetadata({
      calibratedJudgeTier: 'advanced'
    }, 'qwen2.5:7b');

    expect(recommended.effectiveTier).toBe('advanced');
    expect(recommended.source).toBe('recommended');
    expect(calibrated.effectiveTier).toBe('advanced');
    expect(calibrated.source).toBe('calibrated');
  });

  test('prefers inferred tier when stale legacy metadata downgrades a larger model', () => {
    const result = resolveJudgeTierMetadata({
      judgeTier: 'basic'
    }, 'qwen2.5:14b-instruct-q4_K_M');

    expect(result.legacyTier).toBe('basic');
    expect(result.inferredTier).toBe('advanced');
    expect(result.effectiveTier).toBe('advanced');
    expect(result.source).toBe('inferred');
  });

  test('keeps legacy tier when it is at least as strong as the inferred tier', () => {
    const result = resolveJudgeTierMetadata({
      judgeTier: 'advanced'
    }, 'qwen2.5:7b');

    expect(result.legacyTier).toBe('advanced');
    expect(result.inferredTier).toBe('standard');
    expect(result.effectiveTier).toBe('advanced');
    expect(result.source).toBe('legacy');
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

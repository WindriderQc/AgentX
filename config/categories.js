/**
 * Shared Category Configuration
 * ==============================
 * Single source of truth for both category systems used across AgentX.
 *
 * TWO SEPARATE NAMESPACES:
 *   - MANUAL_CATEGORIES: Human-assigned model roles (7 categories)
 *   - BENCHMARK_CATEGORIES: AI benchmark prompt categories (12 categories)
 *
 * USED BY:
 *   - generalistScore.js (weights)
 *   - ModelRegistry.js (schema enum, task router)
 *   - Leaderboard UI (tabs, badges, colors)
 *   - Model categorization UI (charts, filters)
 */

const MANUAL_CATEGORIES = {
  ops:        { label: 'Ops/Glue',   faIcon: 'fa-bolt',           color: '#10b981' },
  coding:     { label: 'Coding',     faIcon: 'fa-code',           color: '#7c9fff' },
  reasoning:  { label: 'Reasoning',  faIcon: 'fa-brain',          color: '#a78bfa' },
  specialist: { label: 'Specialist', faIcon: 'fa-star',           color: '#ec4899' },
  generalist: { label: 'Generalist', faIcon: 'fa-cubes',          color: '#94a3b8' },
  embedding:  { label: 'Embedding',  faIcon: 'fa-vector-square',  color: '#8b5cf6' },
  judge:      { label: 'Judge',      faIcon: 'fa-gavel',          color: '#f59e0b' }
};

const BENCHMARK_CATEGORIES = {
  code:                   { label: 'Coding',                faIcon: 'fa-code',                 color: '#7c9fff' },
  coding:                 { label: 'Coding',                faIcon: 'fa-code',                 color: '#7c9fff' },
  reasoning:              { label: 'Reasoning',             faIcon: 'fa-brain',                color: '#a78bfa' },
  factual:                { label: 'Factual',               faIcon: 'fa-book',                 color: '#34d399' },
  math:                   { label: 'Math',                  faIcon: 'fa-calculator',           color: '#fbbf24' },
  creative:               { label: 'Creative',              faIcon: 'fa-paint-brush',          color: '#f87171' },
  general:                { label: 'General',               faIcon: 'fa-tag',                  color: '#64748b' },
  'instruction-following':{ label: 'Instruction Following', faIcon: 'fa-list-check',           color: '#06b6d4' },
  summarization:          { label: 'Summarization',         faIcon: 'fa-compress-alt',         color: '#14b8a6' },
  translation:            { label: 'Translation',           faIcon: 'fa-language',             color: '#f472b6' },
  'multi-turn-reasoning': { label: 'Multi-Turn Reasoning',  faIcon: 'fa-comments',             color: '#c084fc' },
  'context-retention':    { label: 'Context Retention',     faIcon: 'fa-memory',               color: '#fb923c' },
  'edge-cases':           { label: 'Edge Cases',            faIcon: 'fa-exclamation-triangle', color: '#a3e635' },
  refactoring:            { label: 'Refactoring',           faIcon: 'fa-recycle',              color: '#38bdf8' },
  debugging:              { label: 'Debugging',             faIcon: 'fa-bug',                  color: '#ef4444' },
  explanation:            { label: 'Explanation',           faIcon: 'fa-chalkboard-teacher',   color: '#818cf8' },
  dialogue:               { label: 'Dialogue',              faIcon: 'fa-comment-dots',         color: '#2dd4bf' }
};

/**
 * Generalist category weights for quality scoring.
 * Weights MUST sum to 1.0 (100%).
 *
 * Core capabilities (60%): Essential for general-purpose use
 * Specialized (30%): Important but less universally needed
 * Quality assurance (10%): Robustness and edge case handling
 */
const GENERALIST_CATEGORY_WEIGHTS = {
  'coding': 0.12,
  'reasoning': 0.13,
  'factual': 0.08,
  'creative': 0.08,
  'instruction-following': 0.08,
  'math': 0.08,
  'summarization': 0.07,
  'multi-turn-reasoning': 0.07,
  'context-retention': 0.05,
  'translation': 0.03,
  'edge-cases': 0.05,
  'general': 0.05,
  // Deep evaluation categories
  'refactoring': 0.03,
  'debugging': 0.03,
  'explanation': 0.03,
  'dialogue': 0.02
};

/**
 * Minimum judge tier per benchmark category.
 * Categories requiring deeper understanding need stronger judge models.
 * Tiers: basic (2-3B), standard (7B), advanced (14B+)
 *
 * Local-first design: max category requirement is standard (7B).
 * Advanced (14B) is enforced only via prompt level, not per-category.
 */
const CATEGORY_MIN_JUDGE_TIER = {
  'coding':                'standard',
  'reasoning':             'standard',
  'factual':               'standard',
  'creative':              'basic',
  'instruction-following': 'basic',
  'math':                  'standard',
  'summarization':         'basic',
  'multi-turn-reasoning':  'standard',
  'context-retention':     'standard',
  'translation':           'basic',
  'edge-cases':            'standard',
  'general':               'basic',
  'refactoring':           'standard',
  'debugging':             'standard',
  'explanation':           'basic',
  'dialogue':              'basic'
};

const CATEGORY_JUDGE_REQUIREMENTS = {
  coding: {
    label: BENCHMARK_CATEGORIES.coding.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.coding,
    reason: 'Code correctness and logic checks need a judge with solid reasoning depth.'
  },
  reasoning: {
    label: BENCHMARK_CATEGORIES.reasoning.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.reasoning,
    reason: 'Logical chain evaluation needs a judge that can follow multi-step inference.'
  },
  factual: {
    label: BENCHMARK_CATEGORIES.factual.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.factual,
    reason: 'Fact checking benefits from a judge with more reliable knowledge and consistency.'
  },
  creative: {
    label: BENCHMARK_CATEGORIES.creative.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.creative,
    reason: 'Creative scoring is subjective, so basic judges are acceptable for lightweight governance.'
  },
  'instruction-following': {
    label: BENCHMARK_CATEGORIES['instruction-following'].label,
    minTier: CATEGORY_MIN_JUDGE_TIER['instruction-following'],
    reason: 'Compliance checks are mostly binary, so small judges are sufficient.'
  },
  math: {
    label: BENCHMARK_CATEGORIES.math.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.math,
    reason: 'Math validation needs a judge with dependable step-by-step verification.'
  },
  summarization: {
    label: BENCHMARK_CATEGORIES.summarization.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.summarization,
    reason: 'Coverage and concision checks are straightforward and do not need heavy judges.'
  },
  'multi-turn-reasoning': {
    label: BENCHMARK_CATEGORIES['multi-turn-reasoning'].label,
    minTier: CATEGORY_MIN_JUDGE_TIER['multi-turn-reasoning'],
    reason: 'Cross-turn coherence checks need stronger working-memory and reasoning capability.'
  },
  'context-retention': {
    label: BENCHMARK_CATEGORIES['context-retention'].label,
    minTier: CATEGORY_MIN_JUDGE_TIER['context-retention'],
    reason: 'Long-context recall checks benefit from judges with steadier attention and consistency.'
  },
  translation: {
    label: BENCHMARK_CATEGORIES.translation.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.translation,
    reason: 'Translation comparisons are pattern-heavy and can be governed with smaller judges.'
  },
  'edge-cases': {
    label: BENCHMARK_CATEGORIES['edge-cases'].label,
    minTier: CATEGORY_MIN_JUDGE_TIER['edge-cases'],
    reason: 'Boundary-condition analysis needs a judge that catches subtle failures reliably.'
  },
  general: {
    label: BENCHMARK_CATEGORIES.general.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.general,
    reason: 'General checks can stay on basic judges unless prompt difficulty demands more.'
  },
  refactoring: {
    label: BENCHMARK_CATEGORIES.refactoring.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.refactoring,
    reason: 'Refactoring quality checks require code-structure understanding beyond simple syntax.'
  },
  debugging: {
    label: BENCHMARK_CATEGORIES.debugging.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.debugging,
    reason: 'Bug-finding evaluation needs dependable code tracing and reasoning.'
  },
  explanation: {
    label: BENCHMARK_CATEGORIES.explanation.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.explanation,
    reason: 'Explanation clarity is relatively easy to judge and can stay at the basic tier.'
  },
  dialogue: {
    label: BENCHMARK_CATEGORIES.dialogue.label,
    minTier: CATEGORY_MIN_JUDGE_TIER.dialogue,
    reason: 'Conversation quality checks are governance-friendly and do not require stronger judges by default.'
  }
};

/**
 * Leaderboard tab groups - maps benchmark categories into UI-friendly tab groups.
 * Each tab can match multiple benchmark categories.
 */
const LEADERBOARD_TAB_GROUPS = [
  { key: '',          label: 'All Models',  faIcon: 'fa-globe',      categories: [] },
  { key: 'coding',    label: 'Coding',      faIcon: 'fa-code',       categories: ['coding'] },
  { key: 'reasoning', label: 'Reasoning',   faIcon: 'fa-brain',      categories: ['reasoning', 'multi-turn-reasoning'] },
  { key: 'knowledge', label: 'Knowledge',   faIcon: 'fa-book',       categories: ['factual', 'general', 'context-retention'] },
  { key: 'creative',  label: 'Creative',    faIcon: 'fa-paint-brush', categories: ['creative', 'edge-cases'] },
  { key: 'language',  label: 'Language',    faIcon: 'fa-language',   categories: ['instruction-following', 'summarization', 'translation'] },
  { key: 'math',      label: 'Math',        faIcon: 'fa-calculator', categories: ['math'] }
];

/**
 * Task-to-category routing map for model router.
 * Maps task type strings to manual category alignment.
 */
const TASK_CATEGORY_MAP = {
  'code_generation': 'coding',
  'code_review': 'coding',
  'deep_reasoning': 'reasoning',
  'analysis': 'reasoning',
  'quick_chat': 'ops',
  'conversation': 'ops',
  'factual_qa': 'generalist',
  'summarization': 'generalist',
  'translation': 'generalist',
  'creative_writing': 'generalist',
  'embedding': 'embedding',
  'quality_scoring': 'judge'
};

module.exports = {
  MANUAL_CATEGORIES,
  BENCHMARK_CATEGORIES,
  GENERALIST_CATEGORY_WEIGHTS,
  CATEGORY_MIN_JUDGE_TIER,
  CATEGORY_JUDGE_REQUIREMENTS,
  LEADERBOARD_TAB_GROUPS,
  TASK_CATEGORY_MAP
};

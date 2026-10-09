/**
 * Shared Category Configuration
 * ==============================
 * Single source of truth for both category systems used across AgentX.
 *
 * OWNERSHIP: benchmark owns this file — it is the canonical source for
 * category definitions, weights, and aliases. core/config/categories.js
 * has a partial copy that may diverge; core-specific extensions (judge
 * tiers, etc.) are core-owned. Do not expect the two files to stay in sync.
 *
 * TWO SEPARATE NAMESPACES:
 *   - MANUAL_CATEGORIES: Human-assigned model roles (7 categories)
 *   - BENCHMARK_CATEGORIES: AI benchmark prompt categories (8 categories)
 *
 * BENCHMARK_CATEGORY_KEYS is the one list of prompt categories: schema enums
 * and scoring tables read it instead of repeating the names.
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

// Prompt categories live in shared/ so Core, Benchmark and the pages read one list.
const {
  BENCHMARK_CATEGORIES, BENCHMARK_CATEGORY_KEYS, GENERALIST_CATEGORY_WEIGHTS, LEADERBOARD_TAB_GROUPS
} = require('../../shared/benchmarkCategories');

const BENCHMARK_CATEGORY_ALIASES = {
  code: 'coding',
  refactoring: 'coding',
  debugging: 'coding',
  factual: 'knowledge',
  general: 'knowledge',
  explanation: 'knowledge',
  'instruction-following': 'instruction',
  summarization: 'instruction',
  'multi-turn-reasoning': 'reasoning',
  'context-retention': 'knowledge',
  'edge-cases': 'reasoning',
  dialogue: 'creative'
};

function normalizeBenchmarkCategory(rawCategory, fallback = null) {
  if (rawCategory == null) return fallback;

  const normalized = String(rawCategory)
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');

  if (!normalized) return fallback;

  if (Object.prototype.hasOwnProperty.call(BENCHMARK_CATEGORY_ALIASES, normalized)) {
    return BENCHMARK_CATEGORY_ALIASES[normalized];
  }

  return normalized;
}



/**
 * Task-to-category routing map for model router.
 * Maps task type strings to benchmark-aligned category names.
 */
const TASK_CATEGORY_MAP = {
  code_generation: 'coding',
  code_review: 'coding',
  deep_reasoning: 'reasoning',
  analysis: 'reasoning',
  quick_chat: 'instruction',
  conversation: 'creative',
  factual_qa: 'knowledge',
  summarization: 'instruction',
  translation: 'translation',
  creative_writing: 'creative',
  embedding: 'knowledge',
  quality_scoring: 'reasoning'
};

module.exports = {
  MANUAL_CATEGORIES,
  BENCHMARK_CATEGORIES,
  BENCHMARK_CATEGORY_KEYS,
  BENCHMARK_CATEGORY_ALIASES,
  GENERALIST_CATEGORY_WEIGHTS,
  LEADERBOARD_TAB_GROUPS,
  TASK_CATEGORY_MAP,
  normalizeBenchmarkCategory
};

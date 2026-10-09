'use strict';

/**
 * Benchmark prompt categories: the one list Core, Benchmark and their pages
 * read. Add a category here and every enum, scoring table key list, proxy
 * allowlist and leaderboard column follows; only its scoring rubric and its
 * prompts need writing.
 *
 * Browsers receive the same data as `/js/benchmark-categories.js` (an ES
 * module) or `/js/benchmark-categories.global.js` (sets
 * `window.AgentXBenchmarkCategories` for classic scripts).
 */

const BENCHMARK_CATEGORIES = Object.freeze({
  coding:      { label: 'Coding',      faIcon: 'fa-code',        color: '#7c9fff', emoji: '💻', abbr: 'COD', short: 'Code',   tiny: 'Code' },
  reasoning:   { label: 'Reasoning',   faIcon: 'fa-brain',       color: '#a78bfa', emoji: '🧠', abbr: 'RSN', short: 'Reason', tiny: 'Reas' },
  math:        { label: 'Math',        faIcon: 'fa-calculator',  color: '#fbbf24', emoji: '🔢', abbr: 'MTH', short: 'Math',   tiny: 'Math' },
  knowledge:   { label: 'Knowledge',   faIcon: 'fa-book',        color: '#34d399', emoji: '📚', abbr: 'KNW', short: 'Know',   tiny: 'Know' },
  instruction: { label: 'Instruction', faIcon: 'fa-list-check',  color: '#06b6d4', emoji: '📋', abbr: 'INS', short: 'Instr',  tiny: 'Inst' },
  creative:    { label: 'Creative',    faIcon: 'fa-paint-brush', color: '#f87171', emoji: '🎨', abbr: 'CRE', short: 'Create', tiny: 'Crea' },
  translation: { label: 'Translation', faIcon: 'fa-language',    color: '#f472b6', emoji: '🌐', abbr: 'MLT', short: 'Transl', tiny: 'Tran' },
  // Background agent work: triage, document review, diagnosis, code review,
  // watch reports and tool use, judged against planted findings.
  agent:       { label: 'Agent',       faIcon: 'fa-robot',       color: '#22c55e', emoji: '🤖', abbr: 'AGT', short: 'Agent',  tiny: 'Agnt' }
});

const BENCHMARK_CATEGORY_KEYS = Object.freeze(Object.keys(BENCHMARK_CATEGORIES));

// Generalist score weights; they sum to 1.0. A category without a weight is
// left out of the generalist score.
const GENERALIST_CATEGORY_WEIGHTS = Object.freeze({
  coding:      0.18,
  reasoning:   0.17,
  math:        0.08,
  knowledge:   0.12,
  instruction: 0.12,
  creative:    0.08,
  translation: 0.08,
  agent:       0.17
});

// Leaderboard tabs: "All" plus one per category.
const LEADERBOARD_TAB_GROUPS = Object.freeze([
  { key: '', label: 'All Models', faIcon: 'fa-globe', categories: [] },
  ...BENCHMARK_CATEGORY_KEYS.map(key => ({
    key, label: BENCHMARK_CATEGORIES[key].label, faIcon: BENCHMARK_CATEGORIES[key].faIcon, categories: [key]
  }))
]);

function browserModuleSource() {
  return `// Generated from shared/benchmarkCategories.js; do not edit.\n`
    + `export const CATEGORY_META = Object.freeze(${JSON.stringify(BENCHMARK_CATEGORIES)});\n`
    + 'export const CATEGORY_KEYS = Object.freeze(Object.keys(CATEGORY_META));\n'
    // Same object under a second name, for pages whose own CATEGORY_META derives from it.
    + 'export const BENCHMARK_CATEGORY_META = CATEGORY_META;\n';
}

function browserGlobalSource() {
  return `// Generated from shared/benchmarkCategories.js; do not edit.\n`
    + `window.AgentXBenchmarkCategories = Object.freeze({ meta: ${JSON.stringify(BENCHMARK_CATEGORIES)}, `
    + `keys: ${JSON.stringify(BENCHMARK_CATEGORY_KEYS)} });\n`;
}

/** Serve both browser forms from an Express app. */
function mountBrowserCategories(app) {
  app.get('/js/benchmark-categories.js', (_req, res) => {
    res.type('application/javascript').send(browserModuleSource());
  });
  app.get('/js/benchmark-categories.global.js', (_req, res) => {
    res.type('application/javascript').send(browserGlobalSource());
  });
}

module.exports = {
  BENCHMARK_CATEGORIES,
  BENCHMARK_CATEGORY_KEYS,
  GENERALIST_CATEGORY_WEIGHTS,
  LEADERBOARD_TAB_GROUPS,
  browserModuleSource,
  browserGlobalSource,
  mountBrowserCategories
};

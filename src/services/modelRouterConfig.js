'use strict';
/**
 * Model Router — Static Configuration
 *
 * Centralises all host state, model→host mapping, task→model mapping,
 * and the classification prompt. Provides two pure lookup helpers.
 *
 * Used by: src/services/modelRouter.js
 *
 * Exports:
 *   HOSTS                  — mutable host-URL object (primary/secondary/tertiary)
 *   refreshHosts()         — re-reads env vars into HOSTS in-place
 *   MODEL_ROUTING          — model name → host key mapping
 *   TASK_MODELS            — task type → { model, host }
 *   CLASSIFICATION_PROMPT  — front-door classification prompt string
 *   getTargetForModel(m)   — resolve full URL for a model name
 *   getModelForTask(t)     — resolve { model, host, url } for a task type
 */

// ── Host configuration ─────────────────────────────────────────────────────
// NOTE: Some unit tests set env vars after requiring this module.
// Refresh host URLs from process.env on demand via refreshHosts().

const HOSTS = {
    primary: null,
    secondary: null,
    tertiary: null
};

function normalizeHostUrl(rawValue) {
    if (!rawValue) return null;
    const trimmed = String(rawValue).trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `http://${trimmed}`;
}

function refreshHosts() {
    HOSTS.primary   = normalizeHostUrl(process.env.OLLAMA_HOST);
    // Prefer explicit SECONDARY override if both are present (tests often set it)
    HOSTS.secondary = normalizeHostUrl(process.env.OLLAMA_HOST_SECONDARY || process.env.OLLAMA_HOST_2);
    HOSTS.tertiary  = normalizeHostUrl(process.env.OLLAMA_HOST_TERTIARY  || process.env.OLLAMA_HOST_3);
}

refreshHosts();

// ── Model → Host mapping ───────────────────────────────────────────────────

const MODEL_ROUTING = {
    // UGFrank (99) - Fast models for quick responses
    'qwen2.5:7b-instruct-q4_0': 'primary',
    'qwen2.5:7b': 'primary',  // Alias
    'qwen2.5:3b': 'primary',
    'qwen3:4b': 'primary',
    'qwen3:8b': 'primary',
    'llama3.2:1b': 'primary',
    'llama2:latest': 'primary',
    'whisper': 'primary',

    // UGBrutal (12) - Heavy specialists
    'deepseek-r1:8b': 'secondary',
    'deepseek-r1:32b': 'secondary',
    'deepseek-r1:14b': 'secondary',
    'gemma3:12b-it-qat': 'secondary',
    'gemma3:12b': 'secondary',  // Alias
    'gemma3:4b-it-qat': 'secondary',
    'qwen2.5-coder:14b': 'secondary',
    'qwen2.5-coder:7b': 'secondary',
    'qwen3:14b': 'secondary',
    'llama3.1:8b': 'secondary',
    'olmo2:13b': 'secondary',

    // ClawdX (66) - 32B models
    'qwen2.5:32b-instruct-q4_K_M': 'tertiary',
    'qwen32b:perf': 'tertiary',

    // Embeddings — always light host
    'nomic-embed-text': 'primary',
    'nomic-embed-text:v1.5': 'primary',
    'nomic-embed-text:latest': 'primary'
};

// ── Task type → Model recommendation ──────────────────────────────────────

const TASK_MODELS = {
    quick_chat:      { model: 'qwen2.5:7b-instruct-q4_0', host: 'primary' },
    general_chat:    { model: 'qwen2.5:7b-instruct-q4_0', host: 'primary' },
    code_generation: { model: 'qwen2.5-coder:14b', host: 'secondary' },
    code_review:     { model: 'qwen2.5-coder:14b', host: 'secondary' },
    deep_reasoning:  { model: 'deepseek-r1:8b', host: 'secondary' },
    analysis:        { model: 'gemma3:12b-it-qat', host: 'secondary' },
    summarization:   { model: 'gemma3:12b-it-qat', host: 'secondary' },
    translation:     { model: 'qwen2.5:7b-instruct-q4_0', host: 'primary' },
    embeddings:      { model: 'nomic-embed-text:v1.5', host: 'primary' }
};

// ── Classification prompt ──────────────────────────────────────────────────

const CLASSIFICATION_PROMPT = `You are a query classifier. Classify the user's query into exactly one category.

Categories:
- quick_chat: Simple greetings, small talk, basic questions with short answers
- general_chat: General knowledge questions, explanations, advice
- code_generation: Write code, implement features, create functions/classes
- code_review: Review code, find bugs, suggest improvements
- deep_reasoning: Complex multi-step problems, math, logic puzzles
- analysis: Analyze data, documents, compare things, detailed breakdowns
- summarization: Summarize text, condense information
- translation: Translate between languages

Respond with ONLY the category name, nothing else.

User query: `;

// ── Pure lookup functions ──────────────────────────────────────────────────

/**
 * Get the target Ollama host URL for a specific model.
 * @param {string} model - Model name (e.g., "qwen2.5:7b")
 * @returns {string} Full URL of the Ollama host
 */
function getTargetForModel(model) {
    refreshHosts();
    if (!model) return HOSTS.primary || HOSTS.secondary || HOSTS.tertiary;

    const normalizedModel = model.toLowerCase().trim();
    const hostKey = MODEL_ROUTING[normalizedModel];

    if (hostKey && HOSTS[hostKey]) {
        return HOSTS[hostKey];
    }

    // Keep embeddings on the light host by default.
    if (normalizedModel.includes('embed') || normalizedModel.includes('embedding') || normalizedModel.includes('nomic')) {
        return HOSTS.primary || HOSTS.secondary || HOSTS.tertiary;
    }

    // Use tertiary for very large models when available.
    if (normalizedModel.includes('70b') ||
        normalizedModel.includes('32b') ||
        normalizedModel.includes('34b') ||
        normalizedModel.includes('27b')) {
        return HOSTS.tertiary || HOSTS.secondary || HOSTS.primary;
    }

    // Route heavier reasoning/coder families away from the primary host.
    if (normalizedModel.includes('deepseek') ||
        normalizedModel.includes('coder') ||
        normalizedModel.includes('reason')) {
        return HOSTS.secondary || HOSTS.tertiary || HOSTS.primary;
    }

    return HOSTS.primary || HOSTS.secondary || HOSTS.tertiary;
}

/**
 * Get the recommended model and host for a task type.
 * @param {string} taskType - Task classification
 * @returns {{ model: string, host: string, url: string }}
 */
function getModelForTask(taskType) {
    refreshHosts();
    const task = TASK_MODELS[taskType] || TASK_MODELS.general_chat;
    return {
        model: task.model,
        host: task.host,
        url: HOSTS[task.host]
    };
}

module.exports = {
    HOSTS,
    refreshHosts,
    MODEL_ROUTING,
    TASK_MODELS,
    CLASSIFICATION_PROMPT,
    getTargetForModel,
    getModelForTask
};

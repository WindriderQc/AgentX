'use strict';

const hostConfig = require('../helpers/ollamaHostConfig');

const { normalizeHostUrl } = hostConfig;

// Routing host keys. The env bootstrap slots keep their historical keys; every
// host registered in the inference host registry joins under its own id.
const HOSTS = {
    primary: null,
    secondary: null,
    tertiary: null
};
const BOOTSTRAP_KEYS = new Set(['primary', 'secondary', 'tertiary']);

function refreshHosts() {
    HOSTS.primary = normalizeHostUrl(process.env.OLLAMA_HOST);
    HOSTS.secondary = normalizeHostUrl(process.env.OLLAMA_HOST_SECONDARY || process.env.OLLAMA_HOST_2);
    HOSTS.tertiary = normalizeHostUrl(process.env.OLLAMA_HOST_TERTIARY || process.env.OLLAMA_HOST_3);
    for (const key of Object.keys(HOSTS)) if (!BOOTSTRAP_KEYS.has(key)) delete HOSTS[key];
    const configured = typeof hostConfig.getConfiguredHosts === 'function' ? hostConfig.getConfiguredHosts() : [];
    for (const host of configured || []) {
        if (host.source === 'registry' && !BOOTSTRAP_KEYS.has(host.id)) HOSTS[host.id] = host.url;
    }
}

function envFirstString(...keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (value && String(value).trim()) return String(value).trim();
    }
    return null;
}

function envModel(keys, fallback) {
    return envFirstString(...(Array.isArray(keys) ? keys : [keys])) || fallback;
}

function envHost(keys, fallback) {
    const value = envFirstString(...(Array.isArray(keys) ? keys : [keys]));
    if (value && Object.prototype.hasOwnProperty.call(HOSTS, value) && HOSTS[value]) return value;
    return fallback;
}

refreshHosts();

const DEFAULT_CHAT_HOST = envHost('AGENTX_DEFAULT_CHAT_HOST', 'primary');
const LIGHTWEIGHT_HOST = envHost('AGENTX_LIGHTWEIGHT_HOST', HOSTS.secondary ? 'secondary' : DEFAULT_CHAT_HOST);
const UTILITY_HOST = envHost('AGENTX_UTILITY_HOST', DEFAULT_CHAT_HOST);
const DEEP_REASONING_HOST = envHost('AGENTX_DEEP_REASONING_HOST', DEFAULT_CHAT_HOST);
const MASTER_BRAIN_HOST = envHost('AGENTX_MASTER_BRAIN_HOST', DEEP_REASONING_HOST);
const CODING_SPECIALIST_HOST = envHost('AGENTX_CODING_SPECIALIST_HOST', DEFAULT_CHAT_HOST);
const ANALYSIS_HOST = envHost('AGENTX_ANALYSIS_HOST', DEFAULT_CHAT_HOST);

// These are deployment/bootstrap defaults, not day-2 routing configuration.
// Operators change lanes through persisted RouterTaskConfig app settings;
// explicit caller choices and matching runtime pins remain authoritative.
const DEFAULT_CHAT_MODEL = envModel(
    ['AGENTX_DEFAULT_CHAT_MODEL', 'AGENTX_CHAT_MODEL', 'OLLAMA_MODEL'],
    'gemma4:26b-a4b-it-qat'
);
const DEEP_REASONING_MODEL = envModel('AGENTX_DEEP_REASONING_MODEL', DEFAULT_CHAT_MODEL);
const MASTER_BRAIN_MODEL = envModel('AGENTX_MASTER_BRAIN_MODEL', DEEP_REASONING_MODEL);
const CODING_SPECIALIST_MODEL = envModel('AGENTX_CODING_SPECIALIST_MODEL', DEFAULT_CHAT_MODEL);
const ANALYSIS_MODEL = envModel('AGENTX_ANALYSIS_MODEL', DEFAULT_CHAT_MODEL);
const LIGHTWEIGHT_MODEL = envModel(
    ['AGENTX_LIGHTWEIGHT_MODEL', 'AGENTX_QUICK_CHAT_MODEL'],
    DEFAULT_CHAT_MODEL
);
const NESTOR_ANSWER_LIGHT_MODEL = envModel(
    ['AGENTX_NESTOR_ANSWER_LIGHT_MODEL', 'NESTOR_ANSWER_LIGHT_MODEL'],
    DEFAULT_CHAT_MODEL
);
const NESTOR_ANSWER_LIGHT_HOST = envHost(
    ['AGENTX_NESTOR_ANSWER_LIGHT_HOST', 'NESTOR_ANSWER_LIGHT_HOST'],
    HOSTS.primary ? 'primary' : DEFAULT_CHAT_HOST
);
const USER_GENERAL_CHAT_MODEL = envModel(
    ['AGENTX_GENERAL_CHAT_MODEL', 'AGENTX_AUTOROUTE_GENERAL_MODEL'],
    LIGHTWEIGHT_MODEL
);
const VOICE_PERSONA_READER_MODEL = envModel(
    ['AGENTX_VOICE_PERSONA_READER_MODEL', 'AGENTX_READER_MODEL'],
    LIGHTWEIGHT_MODEL
);
const VOICE_PERSONA_READER_HOST = envHost(
    ['AGENTX_VOICE_PERSONA_READER_HOST', 'AGENTX_READER_HOST'],
    LIGHTWEIGHT_HOST
);
const UTILITY_MODEL = envModel(
    ['AGENTX_UTILITY_MODEL', 'AGENTX_RAG_MODEL', 'AGENTX_LIGHTWEIGHT_MODEL'],
    DEFAULT_CHAT_MODEL
);
const EMBEDDING_TASK_MODEL = envModel(
    ['AGENTX_ROUTER_EMBEDDING_MODEL', 'EMBEDDING_MODEL'],
    'nomic-embed-text:v1.5'
);
const EMBEDDING_TASK_HOST = envHost(
    ['AGENTX_ROUTER_EMBEDDING_HOST', 'AGENTX_EMBEDDING_HOST'],
    HOSTS.secondary ? 'secondary' : DEFAULT_CHAT_HOST
);
const USER_GENERAL_CHAT_HOST = envHost(
    ['AGENTX_GENERAL_CHAT_HOST', 'AGENTX_AUTOROUTE_GENERAL_HOST'],
    LIGHTWEIGHT_HOST
);
const DAILY_OPERATOR_MODEL = envModel(
    ['AGENTX_DAILY_OPERATOR_MODEL', 'AGENTX_DAILY_MODEL'],
    DEFAULT_CHAT_MODEL
);
const DAILY_OPERATOR_HOST = envHost(
    ['AGENTX_DAILY_OPERATOR_HOST', 'AGENTX_DAILY_HOST'],
    DEFAULT_CHAT_HOST
);

const CLASSIFIABLE_TASKS = {
    quick_chat: { model: LIGHTWEIGHT_MODEL, host: LIGHTWEIGHT_HOST },
    general_chat: { model: USER_GENERAL_CHAT_MODEL, host: USER_GENERAL_CHAT_HOST },
    code_generation: { model: CODING_SPECIALIST_MODEL, host: CODING_SPECIALIST_HOST },
    code_review: { model: CODING_SPECIALIST_MODEL, host: CODING_SPECIALIST_HOST },
    deep_reasoning: { model: DEEP_REASONING_MODEL, host: DEEP_REASONING_HOST },
    master_brain: { model: MASTER_BRAIN_MODEL, host: MASTER_BRAIN_HOST },
    analysis: { model: ANALYSIS_MODEL, host: ANALYSIS_HOST },
    summarization: { model: UTILITY_MODEL, host: UTILITY_HOST },
    translation: { model: UTILITY_MODEL, host: UTILITY_HOST }
};

const DIRECT_INVOKE_TASKS = {
    daily_operator: { model: DAILY_OPERATOR_MODEL, host: DAILY_OPERATOR_HOST },
    nestor_answer_light: { model: NESTOR_ANSWER_LIGHT_MODEL, host: NESTOR_ANSWER_LIGHT_HOST },
    rag_query_expansion: { model: UTILITY_MODEL, host: UTILITY_HOST },
    rag_reranking: { model: UTILITY_MODEL, host: UTILITY_HOST },
    rag_compression: { model: UTILITY_MODEL, host: UTILITY_HOST },
    buddy_reaction: { model: LIGHTWEIGHT_MODEL, host: LIGHTWEIGHT_HOST },
    buddy_chat: { model: LIGHTWEIGHT_MODEL, host: LIGHTWEIGHT_HOST },
    voice_persona_chat: { model: LIGHTWEIGHT_MODEL, host: LIGHTWEIGHT_HOST },
    voice_persona_reader: { model: VOICE_PERSONA_READER_MODEL, host: VOICE_PERSONA_READER_HOST },
    janitor_ai: { model: UTILITY_MODEL, host: UTILITY_HOST },
    ops_watch: { model: envModel('AGENTX_OPS_WATCH_MODEL', UTILITY_MODEL), host: envHost('AGENTX_OPS_WATCH_HOST', UTILITY_HOST) },
    mail_review: { model: ANALYSIS_MODEL, host: ANALYSIS_HOST },
    embeddings: { model: EMBEDDING_TASK_MODEL, host: EMBEDDING_TASK_HOST }
};

const DEFAULT_TASK_MODELS = { ...CLASSIFIABLE_TASKS, ...DIRECT_INVOKE_TASKS };
const CLASSIFICATION_MODEL = envModel('AGENTX_CLASSIFIER_MODEL', LIGHTWEIGHT_MODEL);
const CLASSIFICATION_HOST = envHost('AGENTX_CLASSIFIER_HOST', LIGHTWEIGHT_HOST);
const STRICT_CONFIGURED_HOST_TASKS = new Set(['quick_chat', 'buddy_reaction', 'nestor_answer_light', 'ops_watch', 'mail_review']);

// A task may follow its model to another host only when that host has the
// same residency: a CPU-routed task never moves to a GPU host (the model would
// spill), and a GPU-routed task never lands on a slow CPU instance.
function sameResidencyAs(hostKey) {
    const residencyOf = (key) => (typeof hostConfig.getHostResidency === 'function' ? hostConfig.getHostResidency(HOSTS[key]) : 'gpu');
    return (otherKey) => otherKey === hostKey || residencyOf(otherKey) === residencyOf(hostKey);
}

// A task stays on its configured host when it is one of the fixed lanes above,
// or when that host is CPU-resident: each CPU instance is a lane the operator
// fills on purpose in the routing table, so work is not pooled across them.
function staysOnConfiguredHost(taskType, hostKey) {
    if (STRICT_CONFIGURED_HOST_TASKS.has(taskType)) return true;
    return typeof hostConfig.getHostResidency === 'function' && hostConfig.getHostResidency(HOSTS[hostKey]) === 'cpu';
}

module.exports = {
    HOSTS,
    refreshHosts,
    sameResidencyAs,
    staysOnConfiguredHost,
    PRODUCT_DEFAULT_MODEL: DEFAULT_CHAT_MODEL,
    PRODUCT_MASTER_BRAIN_MODEL: MASTER_BRAIN_MODEL,
    CLASSIFIABLE_TASKS,
    DIRECT_INVOKE_TASKS,
    DEFAULT_TASK_MODELS,
    CLASSIFICATION_MODEL,
    CLASSIFICATION_HOST,
    STRICT_CONFIGURED_HOST_TASKS
};

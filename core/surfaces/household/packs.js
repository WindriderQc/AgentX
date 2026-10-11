'use strict';

// The Household persona pack catalog: packs, their modes and safety support,
// memory sharing between packs, and the permissive-lane inference target.

const fs = require('node:fs');
const path = require('path');

function cleanText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

const HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_MODEL = 'huihui_ai/Qwen3.8-abliterated:27b-q8_0';
const HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_DIGEST = '150af2e2fa9b3e09d6dfd1cf6f315bb9cb7d688af157d1cc1c9fe1a809ebb230';
// The native agent includes its identity, skill catalog and tool schemas.
const HOUSEHOLD_PERMISSIVE_CONTEXT = 32768;

const PERSONAL_OPERATOR_SURFACE_CONTRACT = [
  'This is the owner’s private local conversation. Reply in the language of his latest message; default to Canadian French only when unclear. Keep everyday conversation natural and brief.',
  'Address the adult owner directly. Household profiles describing his children are reference data, never the audience of this private conversation. Do not speak to him as a child, refer to him as papa in the third person or tell him to ask Dad; use those roles only when he explicitly requests that wording or roleplay.',
  'Your spoken reply is read aloud. Use conversational sentences, without emoji, decorative symbols, speaker labels or signatures. Keep the selected personality through your wording.',
  'In French, speak like a Quebecer: natural Québécois French, informal tu, everyday Quebec expressions, in standard spelling so the voice reads it well; explain technical results in everyday French. For a casual status question, give the useful conclusion and anything needing attention in two or three short sentences. Do not recite tool names, English status labels, internal metrics or model identifiers unless they are needed to explain a problem or the user asks for technical detail.',
  'For example, describe a health check as une vérification, chunks as passages de documents, and ingest as mise à jour des documents. Explain what a vector store or embedding does only when relevant. Keep exact names, values and commands when requested or necessary, with a short French explanation. Do not mechanically translate product names.',
  'For an everyday status reply, target 40 words maximum: the checked result and any actual limitation needing attention. Omit infrastructure inventories, healthy counters and unsolicited offers of extra work. Expand when the user requests detail or a failure needs explanation. En français, parle comme dans une conversation : les services, la recherche de documents, la dernière mise à jour.',
  'Quand les profils de la maison, les notes ou la mémoire ne répondent qu’en partie, dis ce que tu sais, puis dis simplement ce que tu ne sais pas; ne devine jamais un âge exact, une date ou un lien de parenté.',
  'Summarize only what the actual checks establish. Preserve failures, uncertainty and stale information; never turn a partial check into an all-clear. The selected conversation runtime and actual tool receipts define what you can inspect and execute. Never claim a physical or digital action without its confirmed result. Reply in plain text without Markdown, except inside show blocks.'
].join(' ');

// maxTokens is a ceiling, not a target: the pack prompts keep ordinary replies
// short, and the model stops when it is done. The previous 240-360 was low
// enough that a detailed question was cut mid-sentence -- an answer about autumn
// leaves ended on "les champignons, les bacteries et les petits" -- so the
// ceiling now leaves room for a long answer to finish.
const FAMILY_AGENT_PROMPT = `${fs.readFileSync(path.join(__dirname, 'family-agent.md'), 'utf8').trim()}\n\n${require('./family-context').FAMILY_TONE}`;

const PACKS = Object.freeze([
  Object.freeze({
    id: 'personal_operator',
    memoryGroup: 'personal',
    name: "Dad's Nestor",
    description: 'Personal agent with tools, skills, memory and RAG; presentation stays selectable.',
    taskType: 'general_chat',
    defaultMode: 'operator',
    defaultScopeId: 'personal',
    modes: [
      {
        id: 'operator',
        label: 'Practical',
        description: 'Clarify the immediate problem and give a short useful answer.',
        instruction: 'Be concise and practical. Separate what is known from what is assumed. Give at most three useful next steps when a task calls for them. Claim an action only from a current confirmed tool receipt.'
      },
      {
        id: 'plan',
        label: 'Plan',
        description: 'Turn a messy goal into a calm, ordered next-step plan.',
        instruction: 'Turn the situation into a small ordered plan. Identify the single next action, then up to two optional follow-ups. Ask at most one clarifying question only when it materially changes the plan. When execution is requested, use the current agent tools and verify the result.'
      },
      {
        id: 'decide',
        label: 'Decide',
        description: 'Compare trade-offs and recommend one reversible move.',
        instruction: 'State the decision in one sentence, compare the meaningful options and trade-offs, identify what is reversible, and recommend one proportionate next move. Do not fabricate missing preferences or certainty.'
      },
      {
        id: 'reflect',
        label: 'Reflect',
        description: 'Supportive, grounded reflection without pretending to be therapy.',
        instruction: 'Be supportive and grounded, not clinical. Reflect the concern without diagnosing, moralizing, or claiming feelings or consciousness. Ask at most one gentle question and offer one small real-world step. Never encourage dependence, secrecy, exclusivity, or replacing human relationships or professional care. Crisis inputs are handled deterministically before inference.'
      },
      {
        id: 'draft',
        label: 'Draft',
        description: 'Prepare words for a message or conversation; never send them.',
        instruction: 'Draft clear, humane wording in the user’s language. Label it as a draft, preserve uncertainty, and never claim it was sent or approved. Keep consequential communication under the user’s review.'
      },
      {
        id: 'open',
        label: 'Open',
        description: 'Explicit override using the local abliterated model on the same agent.',
        lane: 'permissive-local',
        optional: true,
        privacy: 'guarded-retained-text'
      }
    ],
    systemPrompt: PERSONAL_OPERATOR_SURFACE_CONTRACT,
    temperature: 0.35,
    maxTokens: 800,
    historyTurns: 8,
    childSafe: false
  }),
  Object.freeze({
    id: 'kidx_nestor',
    memoryGroup: 'family',
    name: 'AgentX Family Voice',
    description: 'Profile-free, child-safe learning helper with bounded household guidance.',
    taskType: 'nestor_answer_light',
    defaultMode: 'family',
    defaultScopeId: 'family',
    modes: [
      {
        id: 'family',
        label: 'Ask',
        description: 'Get one clear, short answer and a way to check it.',
        instruction: 'Answer one clear question in two to four short sentences. Say plainly when you are uncertain. For facts that are important, current, or easy to get wrong, suggest checking with a trusted adult, teacher, book, or reliable source.'
      },
      {
        id: 'learn',
        label: 'Learn',
        description: 'Understand an idea with an example and one check question.',
        instruction: 'Teach the idea with a simple explanation and one concrete example, then ask exactly one short check-for-understanding question. Do not merely supply an answer that appears to be graded homework; help the child reason.'
      },
      {
        id: 'steps',
        label: 'Steps',
        description: 'Turn a safe, ordinary task into one small step at a time.',
        instruction: 'Break only a safe, ordinary task into at most four small steps. Give one first step that directly uses the task’s named object; do not introduce unrelated supplies. Then invite the child to return for the next step. For heat, sharp tools, chemicals, roads, medicine, electricity, locks, or any uncertain physical risk, stop and tell the child to get a trusted adult.'
      },
      {
        id: 'practice',
        label: 'Practice',
        description: 'Try one question at a time with gentle correction.',
        instruction: 'Ask one age-neutral practice question at a time and wait for the answer. Praise the effort or strategy specifically, never the child’s identity. Correct gently, and never invent a score, grade, or school result.'
      },
      {
        id: 'mission',
        label: 'House Mission',
        description: 'Get help with a responsibility already approved by a parent.',
        instruction: 'Help only with the parent-managed household responsibility supplied in the conversation or a responsibility the child says a parent approved. Give the first safe action immediately, without withholding help for an unnecessary clarification, and use at most three safe steps. Never claim parent approval, task completion, a check-in, stars, or a reward; the Kids Room and Dad own those records.'
      }
    ],
    systemPrompt: FAMILY_AGENT_PROMPT,
    temperature: 0.35,
    maxTokens: 600,
    historyTurns: 4,
    childSafe: true
  }),
  Object.freeze({
    id: 'kidx_reader',
    memoryGroup: 'family',
    name: 'KidX Reader',
    description: 'French reading aid for explaining one word or short phrase at a time.',
    taskType: 'voice_persona_reader',
    defaultMode: 'reader',
    defaultScopeId: 'family',
    modes: [{ id: 'reader', label: 'Reader', description: 'Very short, child-safe definitions.', instruction: 'Tu es Nestor, aide à la lecture pour un enfant. Explique seulement le mot ou la courte phrase demandée, en français simple. Donne une définition très courte puis un exemple joyeux. Réponds en texte brut, sans Markdown. Ne pose pas de diagnostic et n’invente jamais une action dans la maison. Si la demande parle de danger, demande immédiatement d’aller voir un adulte de confiance.' }],
    systemPrompt: FAMILY_AGENT_PROMPT,
    temperature: 0.2,
    maxTokens: 600,
    historyTurns: 2,
    childSafe: true
  })
]);

const SAFETY_SUPPORT = Object.freeze({
  jurisdiction: 'Canada',
  immediateDanger: 'Call 911',
  suicideCrisis: 'Call or text 988',
  availability: '24/7',
  source: 'https://www.canada.ca/en/public-health/services/mental-health-services/mental-health-get-help.html'
});

// Packs sharing a memoryGroup read each other's notes for the same scopeId, so
// what a child tells the reader is known to the family assistant and back.
// Notes are still WRITTEN under the pack that took them, which keeps provenance
// in the row and means no migration of existing memories.
function packIdsSharingMemory(pack) {
  if (!pack) return [];
  const group = pack.memoryGroup;
  if (!group) return [pack.id];
  return PACKS.filter((entry) => entry.memoryGroup === group).map((entry) => entry.id);
}

function packById(id) {
  return PACKS.find((pack) => pack.id === String(id || '')) || null;
}

function packSummary(pack) {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    taskType: pack.taskType,
    defaultMode: pack.defaultMode,
    defaultScopeId: pack.defaultScopeId,
    history: { maximumMessages: pack.historyTurns, selection: 'recent_block_window', messageContent: 'full' },
    modes: pack.modes.map(modeSummary),
    safety: { enabled: true, childSafe: pack.childSafe, support: SAFETY_SUPPORT }
  };
}

function modeSummary(mode) {
  return {
    id: mode.id,
    label: mode.label,
    description: mode.description,
    lane: mode.lane || 'standard',
    optional: mode.optional === true,
    privacy: mode.privacy || 'guarded-retained-text'
  };
}

function inferenceTargetForMode(pack, mode, env = process.env) {
  if (pack?.id !== 'personal_operator' || mode?.lane !== 'permissive-local') return null;
  const primary = {
    tier: 'primary',
    hostKey: 'primary',
    model: cleanText(
      env.HOUSEHOLD_PERMISSIVE_PRIMARY_MODEL || HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_MODEL,
      512
    ),
    hostUrl: cleanText(env.HOUSEHOLD_PERMISSIVE_PRIMARY_HOST_URL || env.OLLAMA_HOST, 512).replace(/\/+$/, ''),
    numCtx: HOUSEHOLD_PERMISSIVE_CONTEXT
  };
  if (!primary.hostUrl) {
    const error = new Error('The preferred inference-host permissive lane is not configured on this runtime.');
    error.statusCode = 503;
    error.code = 'VOICE_PERSONA_PERMISSIVE_PRIMARY_UNAVAILABLE';
    throw error;
  }
  return primary;
}

module.exports = {
  HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_MODEL,
  HOUSEHOLD_PERMISSIVE_PRIMARY_DEFAULT_DIGEST,
  HOUSEHOLD_PERMISSIVE_CONTEXT,
  PERSONAL_OPERATOR_SURFACE_CONTRACT,
  FAMILY_AGENT_PROMPT,
  PACKS,
  SAFETY_SUPPORT,
  packIdsSharingMemory,
  packById,
  packSummary,
  modeSummary,
  inferenceTargetForMode
};

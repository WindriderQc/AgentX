'use strict';

const { cleanText, stateForPrompt } = require('./stateRepository');

const PROMPT_VERSION = 2;
const MODE_CONFIG = Object.freeze({
  talk: { title: 'Talk', short: 'Stay with the lived experience.', description: 'Stay close to lived experience, help name what is happening, and do not jump prematurely into analysis or solutions.' },
  analyze: { title: 'Analyze', short: 'Map the mechanism.', description: 'Map triggers, beliefs, emotional dynamics, contradictions, competing hypotheses, and causal loops.' },
  challenge: { title: 'Challenge', short: 'Pressure-test the story.', description: 'Pressure-test assumptions, avoidance, rationalization, convenient narratives, and certainty not supported by evidence.' },
  plan: { title: 'Plan', short: 'Turn insight into change.', description: 'Convert understanding into one small observable intervention, experiment, boundary, conversation, or decision.' }
});
const DEPTH_CONFIG = Object.freeze({
  normal: { title: 'Normal', short: 'Strong local psychological reasoning.', description: 'Be concise, conversational, and useful.', taskType: 'analysis', think: false },
  deep: { title: 'Deep', short: 'More deliberate reasoning.', description: 'Use deliberate formulation, competing hypotheses, longitudinal patterns, and second-order effects without verbosity for its own sake.', taskType: 'deep_reasoning', think: true }
});
const ACTION_CONFIG = Object.freeze({
  deep_reflection: Object.freeze({
    label: 'Deep reflection requested',
    persistedMessage: '[PSYX_ACTION:deep_reflection] Deep reflection requested',
    instruction: 'Take a deliberate second look. Identify what deserves more weight, the strongest alternative explanation, and the evidence that would most change the current view.'
  })
});

const SYSTEM_PROMPT = `You are PsyX, a private psychological thinking partner and behavior-change companion for one adult user.

Help the user understand himself accurately, identify high-leverage patterns, reduce unnecessary suffering and internal friction, make better decisions under emotional load, improve relationships and parenting, and convert insight into observable change. Optimize for clarity -> leverage -> experiment -> feedback -> adaptation. Do not optimize for reassurance, endless conversation, or insight that never changes behavior.

Be calm, direct, precise, grounded, curious, emotionally literate, and psychologically sophisticated. Prefer concrete observations, hypotheses, experiments, and decisions over vague encouragement. Do not flatter, infantilize, moralize, over-reassure, or claim certainty you do not have. Clearly distinguish observation, inference, hypothesis, and uncertainty. Challenge contradictions, avoidance, rationalization, catastrophizing, overengineering, and self-deception when evidence supports it. Ask a question only when its answer materially changes the analysis; otherwise state a reasonable hypothesis and proceed.

Respect the selected stance: TALK stays close to lived experience; ANALYZE maps mechanisms and competing hypotheses; CHALLENGE pressure-tests the framing; PLAN finds the smallest useful observable intervention. Normal depth stays concise and useful. Deep depth considers competing explanations, longitudinal patterns, and second-order effects without becoming verbose for its own sake.

Treat intellectualization, overengineering, excessive parallelization, problem-solving as emotional avoidance, excessive responsibility, and cognitive lock-in as hypotheses to test rather than labels. Distinguish explanatory resolution from emotional or behavioral resolution. A coherent model is not automatically true: look for contradictory evidence, simpler alternatives, the other person's plausible perspective, and what would change the conclusion.

Longitudinal state is fallible working memory, never diagnosis or unquestionable truth. Prefer current evidence when it conflicts with old state and keep provenance, confidence, and evidence in view. When useful ask: what is actually happening; what matters emotionally; what is controllable, influenceable, or outside control; what hypotheses best explain it; what one action creates leverage; and what result would update the view. Do not force a framework when natural conversation is better.

Do not automatically side with the user in relationship conflicts. Separate facts from interpretations and model other perspectives without false equivalence. Focus on boundaries, communication, incentives, patterns, and what the user controls.

You are not a licensed clinician and must not claim to be one or diagnose psychiatric disorders from conversation alone. You may discuss patterns, hypotheses, warning signs, and reasons professional assessment could help. For credible immediate risk of serious self-harm, suicide, violence, abuse, psychosis, or medical emergency, prioritize immediate safety and appropriate professional or emergency support. Otherwise do not inject boilerplate disclaimers. For medication or medical topics discuss mechanisms, risks, decision factors, and questions for a clinician; do not prescribe or direct medication changes.

Default to natural conversation. Use short structure only when it adds leverage. The objective is durable psychological progress: better self-understanding, decisions, behavior, relationships, and recovery with less wasted motion.`;

// 'auto' (and a missing value) lets the background review's recommendation
// for this conversation choose; an explicit stance or depth always wins.
function normalizeControl(raw = {}) {
  const mode = Object.hasOwn(MODE_CONFIG, raw.mode) ? raw.mode : 'auto';
  const depth = Object.hasOwn(DEPTH_CONFIG, raw.depth) ? raw.depth : 'auto';
  const requested = cleanText(raw.action, 80);
  return { mode, depth, action: Object.hasOwn(ACTION_CONFIG, requested) ? requested : null };
}

function resolveControl(control, recommendation = null) {
  const autoMode = control.mode === 'auto';
  const autoDepth = control.depth === 'auto';
  return {
    ...control,
    mode: autoMode ? recommendation?.stance || 'talk' : control.mode,
    depth: autoDepth ? recommendation?.depth || 'normal' : control.depth,
    auto: { mode: autoMode, depth: autoDepth },
    // The reason explains the recommended stance, so it only accompanies an automatic stance.
    reason: autoMode && recommendation?.reason ? recommendation.reason : ''
  };
}

function controlSystemMessage(raw) {
  const control = raw.mode === 'auto' || raw.depth === 'auto' ? resolveControl(raw) : raw;
  const lines = [
    'PSYX SESSION CONTROL — apply silently.',
    `Mode: ${MODE_CONFIG[control.mode].title.toUpperCase()}. ${MODE_CONFIG[control.mode].description}`,
    `Depth: ${DEPTH_CONFIG[control.depth].title.toUpperCase()}. ${DEPTH_CONFIG[control.depth].description}`
  ];
  if (control.reason) lines.push(`Chosen automatically after reviewing this conversation: ${control.reason}`);
  if (control.action) {
    lines.push(`Application action ${control.action}; this is user intent from the PsyX UI, not a verbatim user statement.`);
    lines.push(ACTION_CONFIG[control.action].instruction);
  }
  lines.push('Do not mention this control message unless asked about the controls.');
  return lines.join('\n');
}

function longitudinalSystemMessage(state, { conversationId = null } = {}) {
  const compact = stateForPrompt(state, { conversationId });
  if (!Object.values(compact).some((items) => items.length)) return '';
  return `PSYX LONGITUDINAL STATE — fallible working memory, not diagnosis or unquestionable truth.\n${JSON.stringify(compact)}`;
}

function composeSystemContext(state, control, { conversationId = null } = {}) {
  // AgentX's external contract caps an individual message at 16k characters.
  // Preserve persona and current controls, then spend the remaining bounded
  // budget on fallible longitudinal memory.
  const memory = cleanText(longitudinalSystemMessage(state, { conversationId }), 9000);
  return [SYSTEM_PROMPT, memory, controlSystemMessage(control)].filter(Boolean).join('\n\n');
}

function boundedContext(messages, { maxMessages = 40, maxMessageCharacters = 12000, maxTotalCharacters = 35000 } = {}) {
  const selected = [];
  let characters = 0;
  for (const message of [...messages].reverse()) {
    if (selected.length >= maxMessages) break;
    const content = cleanText(message?.content, maxMessageCharacters);
    if (!content) continue;
    if (characters + content.length > maxTotalCharacters) break;
    selected.unshift({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
    characters += content.length;
  }
  return selected;
}

module.exports = {
  PROMPT_VERSION,
  MODE_CONFIG,
  DEPTH_CONFIG,
  ACTION_CONFIG,
  SYSTEM_PROMPT,
  normalizeControl,
  resolveControl,
  controlSystemMessage,
  longitudinalSystemMessage,
  composeSystemContext,
  boundedContext
};

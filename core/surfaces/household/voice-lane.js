'use strict';

// The fast voice lane (#262): a light model answers ordinary spoken
// conversation itself and hands everything else to the native agent through a
// single tool. The tool, the instructions, the stable system prompt and the
// reading of the model's answer live here, so the offline replay measures
// exactly what the lane sends and how it decides.

const { packById } = require('./packs');
const { systemPromptFor } = require('./persona-prompt');
const personaCatalog = require('./persona-catalog');

const LANE_PACK_ID = 'personal_operator';
const DELEGATE_TOOL = 'delegate';
const DELEGATE_REASONS = Object.freeze(['live_data', 'action', 'memory_change', 'web', 'other']);

function delegateTool() {
  return {
    type: 'function',
    function: {
      name: DELEGATE_TOOL,
      description: 'Hand this request to the full agent, which has the tools, live data and permissions you lack.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The request restated for the agent, complete on its own, in the user\'s language.' },
          reason: { type: 'string', enum: [...DELEGATE_REASONS], description: 'Why the agent is needed.' }
        },
        required: ['task', 'reason']
      }
    }
  };
}

// One line at the top of the prompt, so the rule is read before the long pack text.
function fastLaneHeader() {
  return `Routing rule, above everything else: in this lane you only talk. Whatever needs a tool, live or personal data, or an action goes to the full agent through the ${DELEGATE_TOOL} tool. The full rule is at the end.`;
}

// The routing rule closes the stable system prefix, nearest to the request. A
// light model follows it only when it is explicit: what the agent can do, the
// phrases that betray a missed hand-over, and a few examples of each side.
function fastLaneInstructions() {
  return [
    `FAST VOICE LANE: ROUTING RULE. You can only talk. Your single tool, ${DELEGATE_TOOL}, hands the request to the full agent, which can: search the web and current events; check live system, service and pipeline status and diagnose problems; read tasks, calendar, mail, finances, home, network and files; play sounds; generate images and build scenes; run commands; send, create, schedule or buy; remember, forget or correct a note.`,
    `Call ${DELEGATE_TOOL} (the tool call alone, no spoken text) whenever the request needs any of that, or a personal or live fact that is neither in the supplied context nor in this conversation, or when it continues or confirms something the agent was doing.`,
    `Answer yourself only when none of it is needed: greetings, small talk, opinions, general knowledge, explanations, stories, jokes, and follow-ups you can ground in this conversation.`,
    `Never say that you will check, look, verify or start something, never say that you cannot do or cannot reach something the agent can, and never report a status, a result or an action that is not in the supplied context: each of those is a request to hand over, so call ${DELEGATE_TOOL} instead.`,
    `Hand over: "Génère une image d'un phare la nuit" (action); "Fais jouer un son de hibou" (action); "Est-ce que tout roule côté services?" (live_data); "Quel temps fera-t-il demain?" (web); "Regarde mes derniers courriels" (live_data); "Trouve pourquoi ça ne fonctionne pas" (live_data); "Souviens-toi que le rendez-vous est mardi" (memory_change); "Oui, vas-y" after the agent offered to do something (action).`,
    `Answer yourself: "Salut, ça va?"; "Explique-moi les marées"; "Raconte une blague"; "Qu'en penses-tu?".`
  ].join(" ");
}

// The catalog personality the personal assistant speaks with by default.
function nestorIdentity() {
  return personaCatalog.generatedPersonas().find(row => row.name === 'nestor')?.systemPrompt || '';
}

// Stable across turns: the routing rule in one line, the personal pack prompt
// without notes, knowledge, receipts or the per-turn language directive, the
// personality, then the full routing rule. Volatile context belongs after it.
function fastLaneSystemPrompt({ modeId, identity } = {}) {
  return [fastLaneHeader(), systemPromptFor(packById(LANE_PACK_ID), { modeId, latestUserText: '' }),
    String(identity || '').trim() || nestorIdentity(), fastLaneInstructions()].filter(Boolean).join('\n\n');
}

const TOOL_CALL_AS_TEXT = /<\/?tool_call\b|["']name["']\s*:\s*["']delegate["']|^\s*delegate\s*[({]/i;

function callArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

// Reads one non-streamed chat answer (Ollama or OpenAI shape).
//   delegated: the model called `delegate`; `valid` is false when its
//              arguments are unusable (the lane still hands the turn over).
//   answered:  plain spoken text.
//   malformed: nothing usable (empty, another tool, a tool call written as text).
function laneDecision(body) {
  const message = body?.message || body?.choices?.[0]?.message || {};
  const answer = typeof message.content === 'string' ? message.content.trim() : '';
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length) {
    const call = calls.find(entry => entry?.function?.name === DELEGATE_TOOL);
    if (!call) return { decision: 'malformed', problem: 'unknown_tool' };
    const args = callArguments(call.function.arguments);
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    const reason = DELEGATE_REASONS.includes(args.reason) ? args.reason : '';
    const valid = Boolean(task && reason);
    return { decision: 'delegated', task, reason, valid, ...(valid ? {} : { problem: 'invalid_arguments' }) };
  }
  if (!answer) return { decision: 'malformed', problem: 'empty' };
  if (TOOL_CALL_AS_TEXT.test(answer)) return { decision: 'malformed', problem: 'tool_call_as_text', answer };
  return { decision: 'answered', answer };
}

module.exports = {
  LANE_PACK_ID, DELEGATE_TOOL, DELEGATE_REASONS,
  delegateTool, fastLaneHeader, fastLaneInstructions, nestorIdentity, fastLaneSystemPrompt, laneDecision
};

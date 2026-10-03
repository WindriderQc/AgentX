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

// Kept short: it sits in the stable system prefix of every spoken turn.
function fastLaneInstructions() {
  return [
    'Fast voice lane. Answer ordinary conversation yourself: greetings, small talk, opinions, explanations, stories, jokes, and follow-ups grounded in this conversation or in the supplied context.',
    `Call the ${DELEGATE_TOOL} tool instead of answering when the answer needs personal or live data that is not supplied (tasks, calendar, mail, finances, home, network, files, web search, current events), when the request is an action or a change (send, create, schedule, buy, remember, forget or correct a note, generate an image), or when you are unsure whether a fact about the owner's life is true.`,
    'Never claim to have checked or done something, and never answer a factual personal question from memory when the answer is not in the supplied context. When you delegate, call the tool only, without spoken text.'
  ].join(' ');
}

// The catalog personality the personal assistant speaks with by default.
function nestorIdentity() {
  return personaCatalog.generatedPersonas().find(row => row.name === 'nestor')?.systemPrompt || '';
}

// Stable across turns: the personal pack prompt without notes, knowledge,
// receipts or the per-turn language directive, then the personality, then the
// lane instructions. Volatile context belongs after this prefix.
function fastLaneSystemPrompt({ modeId, identity } = {}) {
  return [systemPromptFor(packById(LANE_PACK_ID), { modeId, latestUserText: '' }),
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
  delegateTool, fastLaneInstructions, nestorIdentity, fastLaneSystemPrompt, laneDecision
};

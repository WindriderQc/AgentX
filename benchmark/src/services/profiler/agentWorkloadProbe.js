'use strict';

/**
 * Agent workload probe (#833): how a model behaves doing an agent's work, not
 * a single long prompt. Runs in the Full profile under the profiler's Core
 * workload reservation, after the context and quality probes.
 *
 * - session growth: one conversation that keeps growing with cached history,
 *   one source file per turn, as a coding worker's session does;
 * - structured output: the largest JSON answer returned complete and exact;
 * - verification: every planted documentation mismatch found at 8k–64k;
 * - tool turns: consecutive valid tool calls through Ollama's tool API.
 *
 * Every phase is bounded by turns, items and per-call time. Results are
 * scored exactly (agentWorkloadPayload.js); no judge model is involved.
 */

const { chat, generate } = require('../../clients/ollamaClient');
const payload = require('./agentWorkloadPayload');

const PROBE_VERSION = 1;
const SEED = 833;
const SESSION = Object.freeze({ maxContext: 131072, fillLimit: 0.85, turnChars: 12000, maxTurns: 40,
  slowCallMs: 300000, numPredict: 48 });
const OUTPUT_ITEMS = Object.freeze([10, 25, 50, 100, 200]);
const VERIFICATION_SIZES = Object.freeze([8192, 32768, 65536]);
const TOOL_CLAIMS = 12;
const CHARS_PER_TOKEN = 3.6;

const ms = ns => (Number(ns) > 0 ? Math.round(Number(ns) / 1e6) : null);

function rethrowAbort(error, signal) {
  if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
}

/**
 * Largest context reached while a condition still held, scanning turns in
 * order and stopping at the first turn where it failed.
 */
function lastBefore(rows, ok) {
  let value = null;
  for (const row of rows) {
    if (!ok(row)) break;
    value = row.contextTokens;
  }
  return value;
}

async function runSessionGrowth(hostUrl, modelName, { maxVerifiedContext, timeoutMs, signal, checkpoint, onProgress, clock = Date.now }) {
  const numCtx = Math.min(Number(maxVerifiedContext) || 0, SESSION.maxContext);
  if (!numCtx) return { status: 'skipped', reason: 'No verified context', turns: [] };
  const messages = [{ role: 'system', content: payload.SESSION_SYSTEM }];
  const turns = [];
  let stopReason = 'max_turns';
  let charsPerToken = null;
  for (let index = 0; index < SESSION.maxTurns; index += 1) {
    checkpoint();
    const turn = payload.sessionTurn(SEED, index, SESSION.turnChars);
    messages.push({ role: 'user', content: turn.content });
    const startedAt = clock();
    let data;
    try {
      data = await chat(hostUrl, { model: modelName, messages, stream: false, think: false,
        options: { num_ctx: numCtx, num_predict: SESSION.numPredict, temperature: 0, seed: 7 } }, { timeoutMs, signal });
    } catch (error) {
      rethrowAbort(error, signal);
      turns.push({ turn: index + 1, status: 'error', error: error.message, latencyMs: clock() - startedAt });
      stopReason = 'error';
      break;
    }
    const answer = String(data?.message?.content || '');
    const score = payload.scoreSessionAnswer(answer, turn.claim);
    const promptTokens = Number(data?.prompt_eval_count) || 0;
    // Ollama versions differ on whether a cached prefix counts in
    // prompt_eval_count. The first turn has no cache, so it calibrates
    // characters per token; the session size is then measured from the
    // characters actually sent, never from a cache-dependent counter.
    const sentChars = messages.reduce((total, message) => total + String(message.content || '').length, 0);
    if (!charsPerToken && promptTokens > 0) charsPerToken = sentChars / promptTokens;
    const contextTokens = Math.round(sentChars / (charsPerToken || CHARS_PER_TOKEN)) + (Number(data?.eval_count) || 0);
    const row = { turn: index + 1, status: 'pass', contextTokens, newPromptTokens: promptTokens,
      latencyMs: clock() - startedAt, promptEvalMs: ms(data?.prompt_eval_duration), evalMs: ms(data?.eval_duration),
      correct: score.correct, failure: score.reason };
    turns.push(row);
    onProgress({ phase: 'session', row });
    messages.push({ role: 'assistant', content: answer });
    if (row.latencyMs >= SESSION.slowCallMs) { stopReason = 'slow_call'; break; }
    if (contextTokens >= numCtx * SESSION.fillLimit) { stopReason = 'context_full'; break; }
  }
  const measured = turns.filter(row => row.status === 'pass');
  const base = measured.slice(0, 3).map(row => row.latencyMs).sort((a, b) => a - b)[Math.min(1, measured.length - 1)] || null;
  return {
    status: measured.length ? 'measured' : 'error',
    numCtx,
    stopReason,
    baselineLatencyMs: base,
    // Largest session size while each call stayed under twice the opening latency.
    latencyKneeContext: base ? lastBefore(measured, row => row.latencyMs <= base * 2) : null,
    // Largest session size with every answer so far exact.
    accuracyContext: lastBefore(measured, row => row.correct),
    correctTurns: measured.filter(row => row.correct).length,
    turns
  };
}

async function runStructuredOutput(hostUrl, modelName, { numCtx, timeoutMs, signal, checkpoint, onProgress, clock = Date.now }) {
  const results = [];
  for (const items of OUTPUT_ITEMS) {
    checkpoint();
    const built = payload.structuredOutputPrompt(SEED, items);
    const startedAt = clock();
    let data;
    try {
      data = await generate(hostUrl, { model: modelName, prompt: built.prompt, stream: false, think: false,
        options: { num_ctx: numCtx, num_predict: items * 48 + 256, temperature: 0, seed: 7 } }, { timeoutMs, signal });
    } catch (error) {
      rethrowAbort(error, signal);
      results.push({ items, status: 'error', error: error.message, latencyMs: clock() - startedAt });
      break;
    }
    const score = payload.scoreStructuredOutput(data?.response, built.facts);
    const row = { items, status: score.passed ? 'pass' : 'fail', outputTokens: Number(data?.eval_count) || 0,
      doneReason: data?.done_reason || null, latencyMs: clock() - startedAt, ...score };
    results.push(row);
    onProgress({ phase: 'output', row });
    if (!score.passed) break;
  }
  const passing = results.filter(row => row.status === 'pass');
  const best = passing[passing.length - 1] || null;
  return { reliableItems: best?.items || null, reliableOutputTokens: best?.outputTokens || null, results };
}

async function runVerification(hostUrl, modelName, { maxVerifiedContext, timeoutMs, signal, checkpoint, onProgress, clock = Date.now }) {
  const sizes = VERIFICATION_SIZES.filter(size => size <= (Number(maxVerifiedContext) || 0));
  const results = [];
  for (const numCtx of sizes) {
    checkpoint();
    const built = payload.verificationPrompt(SEED + numCtx, Math.floor(numCtx * 0.75 * CHARS_PER_TOKEN));
    const startedAt = clock();
    let data;
    try {
      data = await generate(hostUrl, { model: modelName, prompt: built.prompt, stream: false, think: false,
        options: { num_ctx: numCtx, num_predict: 768, temperature: 0, seed: 7 } }, { timeoutMs, signal });
    } catch (error) {
      rethrowAbort(error, signal);
      results.push({ numCtx, status: 'error', error: error.message, latencyMs: clock() - startedAt });
      break;
    }
    const promptTokens = Number(data?.prompt_eval_count) || 0;
    // Ollama silently drops the start of a prompt that does not fit.
    const status = promptTokens + 768 > numCtx ? 'overflow' : null;
    const score = payload.scoreVerification(data?.response, built);
    const row = { numCtx, status: status || (score.passed ? 'pass' : 'fail'), promptTokens,
      latencyMs: clock() - startedAt, ...score };
    results.push(row);
    onProgress({ phase: 'verification', row });
  }
  return { verifiedContext: lastBefore(results.map(row => ({ ...row, contextTokens: row.numCtx })), row => row.status === 'pass'), results };
}

async function runToolTurns(hostUrl, modelName, { numCtx, timeoutMs, signal, checkpoint, onProgress }) {
  const task = payload.toolTask(SEED, TOOL_CLAIMS);
  const messages = [{ role: 'system', content: task.system }, { role: 'user', content: task.user }];
  const byId = new Map(task.claims.map(claim => [claim.id, claim]));
  const recorded = new Map();
  let validTurns = 0;
  let stopReason = 'max_turns';
  const maxTurns = TOOL_CLAIMS * 2 + 6;
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    checkpoint();
    let data;
    try {
      data = await chat(hostUrl, { model: modelName, messages, tools: payload.TOOLS, stream: false, think: false,
        options: { num_ctx: numCtx, num_predict: 256, temperature: 0, seed: 7 } }, { timeoutMs, signal });
    } catch (error) {
      rethrowAbort(error, signal);
      stopReason = /tool/i.test(error.message) ? 'tools_unsupported' : 'error';
      break;
    }
    const calls = Array.isArray(data?.message?.tool_calls) ? data.message.tool_calls : [];
    if (!calls.length) { stopReason = recorded.size === TOOL_CLAIMS ? 'finished' : 'stopped_calling'; break; }
    messages.push({ role: 'assistant', content: data.message.content || '', tool_calls: calls });
    let valid = true;
    for (const call of calls) {
      const name = call?.function?.name;
      let args = call?.function?.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      let result;
      if (name === 'read_file' && task.files.has(args?.path)) {
        result = task.files.get(args.path);
      } else if (name === 'record_check' && byId.has(args?.id)) {
        recorded.set(args.id, args);
        result = 'recorded';
      } else {
        valid = false;
        result = 'error: unknown tool or argument';
      }
      messages.push({ role: 'tool', content: result });
    }
    if (!valid) { stopReason = 'invalid_call'; break; }
    validTurns += 1;
    onProgress({ phase: 'tools', row: { turn, validTurns, recorded: recorded.size } });
  }
  const correctChecks = [...recorded.values()].filter(args => {
    const claim = byId.get(args.id);
    return claim && args.verdict === claim.verdict && Number(args.value) === claim.actual;
  }).length;
  return { reliableToolTurns: validTurns, recordedChecks: recorded.size, correctChecks, totalChecks: TOOL_CLAIMS, stopReason };
}

/**
 * @returns {Promise<object>} evidence stored as profile.agentWorkload
 */
async function runAgentWorkloadProbe(hostUrl, modelName, {
  maxVerifiedContext, timeoutMs = 420000, signal, checkpoint = () => {}, onProgress = () => {}, clock = Date.now
} = {}) {
  const startedAt = clock();
  const options = { maxVerifiedContext, timeoutMs, signal, checkpoint, onProgress, clock,
    numCtx: Math.min(Number(maxVerifiedContext) || 8192, 32768) };
  const session = await runSessionGrowth(hostUrl, modelName, options);
  const output = await runStructuredOutput(hostUrl, modelName, options);
  const verification = await runVerification(hostUrl, modelName, options);
  const tools = await runToolTurns(hostUrl, modelName, options);
  return {
    version: PROBE_VERSION,
    payloadVersion: payload.PAYLOAD_VERSION,
    measuredAt: new Date(),
    durationMs: clock() - startedAt,
    session,
    output,
    verification,
    tools,
    summary: {
      sessionLatencyKneeContext: session.latencyKneeContext ?? null,
      sessionAccuracyContext: session.accuracyContext ?? null,
      reliableOutputItems: output.reliableItems,
      reliableOutputTokens: output.reliableOutputTokens,
      verificationVerifiedContext: verification.verifiedContext,
      reliableToolTurns: tools.reliableToolTurns,
      toolChecksCorrect: tools.correctChecks,
      toolChecksTotal: tools.totalChecks
    }
  };
}

module.exports = {
  PROBE_VERSION, SESSION, OUTPUT_ITEMS, VERIFICATION_SIZES,
  runAgentWorkloadProbe,
  _internal: { runSessionGrowth, runStructuredOutput, runVerification, runToolTurns, lastBefore }
};

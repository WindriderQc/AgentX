/**
 * Roundtable Orchestrator
 * Runs multi-agent roundtable discussions: blind round → rebuttal → synthesis
 *
 * Reuses existing infrastructure:
 * - buildOllamaPayload / extractResponse from ollamaResponseHandler
 * - getTargetForModel from modelRouter
 * - getFetchOptions from httpAgent
 */

const fetch = require('node-fetch');
const { EventEmitter } = require('events');
const logger = require('../../../config/logger');
const Roundtable = require('../../../models/Roundtable');
const { buildOllamaPayload, extractResponse, isThinkingModel } = require('../../helpers/ollamaResponseHandler');
const { getTargetForModel } = require('../modelRouter');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { DEFAULT_PANEL, DEFAULT_SYNTHESIZER, REBUTTAL_PREAMBLE, DEFAULT_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS } = require('./defaults');

// Shared emitter registry: roundtableId → EventEmitter
const emitterRegistry = new Map();

/**
 * Resolve host name from target URL (for audit trail)
 * @param {string} target - Ollama host URL
 * @returns {string}
 */
function resolveHostName(target) {
  if (!target) return 'unknown';
  try {
    const url = new URL(target);
    return url.hostname;
  } catch {
    return target;
  }
}

/**
 * Call a single agent (one Ollama inference)
 * @param {Object} agent - { agentId, role, model, systemPrompt }
 * @param {Array} messages - Chat messages array
 * @param {number} timeoutMs - Per-call timeout
 * @returns {Object} { response, thinking, stats, error, target, hostName }
 */
async function callAgent(agent, messages, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const startedAt = new Date();
  const target = getTargetForModel(agent.model);
  const hostName = resolveHostName(target);

  if (!target) {
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: null },
      error: `No host found for model ${agent.model}`,
      target: null, hostName: 'unknown', startedAt, completedAt: new Date()
    };
  }

  const url = `${target}/api/chat`;
  const payload = buildOllamaPayload({ model: agent.model, messages });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOpts = getFetchOptions(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const parsed = extractResponse(data, agent.model);
    const completedAt = new Date();
    const latencyMs = completedAt - startedAt;

    return {
      response: parsed.content || '',
      thinking: parsed.thinking || null,
      stats: {
        tokensPerSecond: parsed.stats?.performance?.tokensPerSecond || null,
        latencyMs,
        promptTokens: parsed.stats?.usage?.promptTokens || null,
        completionTokens: parsed.stats?.usage?.completionTokens || null
      },
      error: null,
      target,
      hostName,
      startedAt,
      completedAt
    };
  } catch (err) {
    clearTimeout(timer);
    const completedAt = new Date();
    const isTimeout = err.name === 'AbortError';
    const errorMsg = isTimeout ? `Timeout after ${timeoutMs}ms` : err.message;

    logger.error('Roundtable callAgent failed', {
      agentId: agent.agentId, model: agent.model, target, error: errorMsg
    });

    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: errorMsg,
      target, hostName, startedAt, completedAt
    };
  }
}

/**
 * Call a single agent with streaming (pipes chunks to EventEmitter)
 * Falls back to non-streaming callAgent if no emitter provided.
 */
async function callAgentStreaming(agent, messages, timeoutMs, emitter, eventPrefix) {
  if (!emitter) return callAgent(agent, messages, timeoutMs);

  const startedAt = new Date();
  const target = getTargetForModel(agent.model);
  const hostName = resolveHostName(target);

  if (!target) {
    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: null },
      error: `No host found for model ${agent.model}`,
      target: null, hostName: 'unknown', startedAt, completedAt: new Date()
    };
  }

  const url = `${target}/api/chat`;
  const payload = buildOllamaPayload({
    model: agent.model,
    messages,
    streamEnabled: true,
    options: { num_predict: -1 }
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOpts = getFetchOptions(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${body.substring(0, 200)}`);
    }

    // Process NDJSON stream
    let fullContent = '';
    let thinkingContent = '';
    let inThinking = false;
    let finalData = null;

    const reader = res.body;
    let buffer = '';

    await new Promise((resolve, reject) => {
      reader.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);

            if (obj.done) {
              finalData = obj;
              continue;
            }

            const token = obj.message?.content || '';
            if (!token) continue;

            // Handle thinking model tokens
            if (isThinkingModel(agent.model)) {
              if (token.includes('<think>')) { inThinking = true; continue; }
              if (token.includes('</think>')) { inThinking = false; continue; }
              if (inThinking) { thinkingContent += token; continue; }
            }

            fullContent += token;
            emitter.emit('chunk', { type: `${eventPrefix}-chunk`, agentId: agent.agentId, round: agent._round, content: token });
          } catch { /* skip malformed lines */ }
        }
      });

      reader.on('end', resolve);
      reader.on('error', reject);
    });

    const completedAt = new Date();
    const latencyMs = completedAt - startedAt;

    // Extract stats from final done message
    const evalDuration = finalData?.eval_duration || 0;
    const evalCount = finalData?.eval_count || 0;
    const promptTokens = finalData?.prompt_eval_count || null;
    const tokensPerSecond = evalDuration > 0 ? (evalCount / (evalDuration / 1e9)) : null;

    return {
      response: fullContent,
      thinking: thinkingContent || null,
      stats: { tokensPerSecond, latencyMs, promptTokens, completionTokens: evalCount || null },
      error: null, target, hostName, startedAt, completedAt
    };
  } catch (err) {
    clearTimeout(timer);
    const completedAt = new Date();
    const isTimeout = err.name === 'AbortError';
    const errorMsg = isTimeout ? `Timeout after ${timeoutMs}ms` : err.message;

    logger.error('Roundtable streaming callAgent failed', {
      agentId: agent.agentId, model: agent.model, target, error: errorMsg
    });

    return {
      response: '', thinking: null,
      stats: { tokensPerSecond: null, latencyMs: completedAt - startedAt },
      error: errorMsg, target, hostName, startedAt, completedAt
    };
  }
}

/**
 * Execute one round of the roundtable (all agents sequentially)
 * @param {Object} roundtableDoc - Mongoose document
 * @param {number} roundNum - Round number (1-based)
 * @param {Array} agents - Panel agent configs
 * @param {Function} buildMessages - (agent) => messages array
 * @param {number} timeoutMs - Per-agent timeout
 * @param {EventEmitter} [emitter] - Optional emitter for streaming
 * @returns {Object} results map { agentId: { response, ... } }
 */
async function executeRound(roundtableDoc, roundNum, agents, buildMessages, timeoutMs, emitter) {
  const results = {};

  // Sequential iteration — preserves GPU-aware ordering
  for (const agent of agents) {
    const messages = buildMessages(agent);

    logger.info('Roundtable agent starting', {
      roundtableId: roundtableDoc._id,
      round: roundNum,
      agentId: agent.agentId,
      model: agent.model
    });

    if (emitter) {
      emitter.emit('chunk', { type: 'turn-start', agentId: agent.agentId, round: roundNum, role: agent.role, model: agent.model });
    }

    // Tag agent with round number for streaming context
    const agentWithRound = { ...agent, _round: roundNum };
    const result = await callAgentStreaming(agentWithRound, messages, timeoutMs, emitter, 'turn');

    if (emitter) {
      emitter.emit('chunk', { type: 'turn-done', agentId: agent.agentId, round: roundNum, stats: result.stats, error: result.error });
    }

    // Persist turn immediately (crash recovery)
    const turn = {
      agentId: agent.agentId,
      role: agent.role,
      round: roundNum,
      model: agent.model,
      target: result.target,
      hostName: result.hostName,
      response: result.response,
      thinking: result.thinking,
      error: result.error,
      stats: result.stats,
      startedAt: result.startedAt,
      completedAt: result.completedAt
    };

    await Roundtable.updateOne(
      { _id: roundtableDoc._id },
      { $push: { turns: turn } }
    );

    // Also update resolved target in panelConfig snapshot
    await Roundtable.updateOne(
      { _id: roundtableDoc._id, 'panelConfig.agentId': agent.agentId },
      { $set: {
        'panelConfig.$.resolvedTarget': result.target,
        'panelConfig.$.resolvedHostName': result.hostName
      }}
    );

    results[agent.agentId] = result;

    logger.info('Roundtable agent completed', {
      roundtableId: roundtableDoc._id,
      round: roundNum,
      agentId: agent.agentId,
      latencyMs: result.stats?.latencyMs,
      hasError: !!result.error
    });
  }

  return results;
}

/**
 * Run the full roundtable discussion
 * @param {string} roundtableId - Mongoose document ID
 * @param {EventEmitter} [emitter] - Optional emitter for streaming events
 */
async function runRoundtable(roundtableId, emitter) {
  const startTime = Date.now();
  let doc = await Roundtable.findById(roundtableId);

  if (!doc) {
    logger.error('Roundtable not found', { roundtableId });
    return;
  }

  try {
    doc.status = 'running';
    await doc.save();

    const agents = doc.panelConfig.map(a => a.toObject());
    const timeoutMs = DEFAULT_TIMEOUT_MS;
    const totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS;

    // Total timeout guard
    const totalTimer = setTimeout(async () => {
      logger.error('Roundtable total timeout exceeded', { roundtableId });
      await Roundtable.updateOne(
        { _id: roundtableId, status: 'running' },
        { $set: { status: 'timeout', error: `Total timeout after ${totalTimeoutMs}ms`, completedAt: new Date(), totalDurationMs: Date.now() - startTime } }
      );
    }, totalTimeoutMs);

    // --- Round 1: Blind analysis ---
    const r1Results = await executeRound(doc, 1, agents, (agent) => [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: doc.question }
    ], timeoutMs, emitter);

    // --- Round 2+: Rebuttals (if configured) ---
    if (doc.rounds >= 2) {
      // Reload doc to get persisted turns
      doc = await Roundtable.findById(roundtableId);
      if (doc.status !== 'running') { clearTimeout(totalTimer); return; }

      for (let roundNum = 2; roundNum <= doc.rounds; roundNum++) {
        const previousTurns = doc.turns.filter(t => t.round === roundNum - 1);

        await executeRound(doc, roundNum, agents, (agent) => {
          // Build rebuttal context: show other agents' previous responses
          const otherResponses = previousTurns
            .filter(t => t.agentId !== agent.agentId && t.response)
            .map(t => `**${t.role}:**\n${t.response}`)
            .join('\n\n');

          return [
            { role: 'system', content: agent.systemPrompt },
            { role: 'user', content: doc.question },
            { role: 'assistant', content: r1Results[agent.agentId]?.response || '' },
            { role: 'user', content: REBUTTAL_PREAMBLE + otherResponses + '\n\n---\nNow provide your rebuttal.' }
          ];
        }, timeoutMs, emitter);

        // Reload for next round
        doc = await Roundtable.findById(roundtableId);
        if (doc.status !== 'running') { clearTimeout(totalTimer); return; }
      }
    }

    // --- Synthesis ---
    doc = await Roundtable.findById(roundtableId);
    if (doc.status !== 'running') { clearTimeout(totalTimer); return; }

    const allTurns = doc.turns;
    const transcriptForSynthesis = allTurns
      .map(t => `[Round ${t.round}] ${t.role} (${t.model}):\n${t.response || t.error || 'No response'}`)
      .join('\n\n---\n\n');

    const synthesizer = doc.synthesizerConfig.toObject ? doc.synthesizerConfig.toObject() : doc.synthesizerConfig;
    const synthMessages = [
      { role: 'system', content: synthesizer.systemPrompt },
      { role: 'user', content: `Original question: ${doc.question}\n\n---\n\nPanel Discussion:\n\n${transcriptForSynthesis}\n\n---\n\nNow synthesize a final verdict.` }
    ];

    if (emitter) {
      emitter.emit('chunk', { type: 'synthesis-start', model: synthesizer.model });
    }

    const synthAgent = { agentId: 'synthesizer', role: 'Synthesizer', model: synthesizer.model, systemPrompt: synthesizer.systemPrompt, _round: 0 };
    const synthResult = await callAgentStreaming(synthAgent, synthMessages, timeoutMs, emitter, 'synthesis');

    if (emitter) {
      emitter.emit('chunk', { type: 'synthesis-done', stats: synthResult.stats, error: synthResult.error });
    }

    clearTimeout(totalTimer);

    // Check if we got timed out while synthesizing
    doc = await Roundtable.findById(roundtableId);
    if (doc.status !== 'running') return;

    // Persist synthesis + complete
    const totalDurationMs = Date.now() - startTime;
    await Roundtable.updateOne(
      { _id: roundtableId },
      { $set: {
        synthesis: {
          model: synthesizer.model,
          target: synthResult.target,
          hostName: synthResult.hostName,
          response: synthResult.response,
          thinking: synthResult.thinking,
          error: synthResult.error,
          stats: synthResult.stats,
          startedAt: synthResult.startedAt,
          completedAt: synthResult.completedAt
        },
        'synthesizerConfig.resolvedTarget': synthResult.target,
        'synthesizerConfig.resolvedHostName': synthResult.hostName,
        status: 'completed',
        totalDurationMs,
        completedAt: new Date()
      }}
    );

    logger.info('Roundtable completed', { roundtableId, totalDurationMs, turns: allTurns.length });
    if (emitter) emitter.emit('chunk', { type: 'done', status: 'completed', totalDurationMs });

  } catch (err) {
    logger.error('Roundtable failed', { roundtableId, error: err.message, stack: err.stack });
    await Roundtable.updateOne(
      { _id: roundtableId },
      { $set: {
        status: 'failed',
        error: err.message,
        totalDurationMs: Date.now() - startTime,
        completedAt: new Date()
      }}
    ).catch(() => {});
    if (emitter) emitter.emit('chunk', { type: 'done', status: 'failed', error: err.message });
  } finally {
    // Clean up emitter from registry
    emitterRegistry.delete(roundtableId);
  }
}

/**
 * Create a new roundtable document (pending state)
 * @param {Object} options
 * @param {string} options.question - The discussion topic
 * @param {number} options.rounds - Number of rounds (1-3, default 2)
 * @param {Array} options.panel - Custom panel config (optional)
 * @param {Object} options.synthesizer - Custom synthesizer config (optional)
 * @param {string} options.workspaceId
 * @param {string} options.userId
 * @param {string} options.source
 * @param {string[]} options.tags
 * @returns {Object} Mongoose document
 */
async function createRoundtable(options) {
  const {
    question,
    rounds = 2,
    panel = DEFAULT_PANEL,
    synthesizer = DEFAULT_SYNTHESIZER,
    workspaceId = null,
    userId = null,
    source = 'api',
    tags = []
  } = options;

  // Merge partial panel overrides with defaults (e.g. model-only overrides from UI)
  const defaultByAgent = {};
  for (const d of DEFAULT_PANEL) { defaultByAgent[d.agentId] = d; }

  const mergedPanel = panel.map(a => {
    const dflt = defaultByAgent[a.agentId] || {};
    return {
      agentId: a.agentId,
      role: a.role || dflt.role || a.agentId,
      model: a.model || dflt.model,
      systemPrompt: a.systemPrompt || dflt.systemPrompt || ''
    };
  });

  const mergedSynthesizer = {
    model: synthesizer.model || DEFAULT_SYNTHESIZER.model,
    systemPrompt: synthesizer.systemPrompt || DEFAULT_SYNTHESIZER.systemPrompt
  };

  const doc = await Roundtable.create({
    question,
    rounds: Math.min(Math.max(rounds, 1), 3),
    panelConfig: mergedPanel,
    synthesizerConfig: mergedSynthesizer,
    status: 'pending',
    workspaceId,
    userId,
    source,
    tags
  });

  return doc;
}

/**
 * Get a roundtable by ID
 */
async function getRoundtable(id) {
  return Roundtable.findById(id);
}

/**
 * List roundtables with pagination
 */
async function listRoundtables({ workspaceId, limit = 20, skip = 0 } = {}) {
  const filter = {};
  if (workspaceId) filter.workspaceId = workspaceId;
  const [docs, total] = await Promise.all([
    Roundtable.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Roundtable.countDocuments(filter)
  ]);
  return { docs, total };
}

module.exports = {
  callAgent,
  callAgentStreaming,
  executeRound,
  runRoundtable,
  createRoundtable,
  getRoundtable,
  listRoundtables,
  emitterRegistry
};

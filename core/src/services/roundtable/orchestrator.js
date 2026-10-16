/**
 * Roundtable Orchestrator
 *
 * Runs the full multi-agent discussion:
 *   Round 1 (blind)  → Rounds 2..N (rebuttals) → Synthesis
 *
 * Streams chunks through an EventEmitter so SSE clients see tokens as they
 * arrive. Persists each completed turn immediately so a restart doesn't lose
 * in-flight state.
 */

const { EventEmitter } = require('events');
const logger = require('../../../config/logger');
const Roundtable = require('../../../models/Roundtable');
const {
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  REBUTTAL_PREAMBLE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  withCouncilAdvisoryGuard
} = require('./defaults');
const { normalizePanel, normalizeSynthesizer, normalizeTurnOrder, spokenBefore } = require('./panelConfig');
const {
  formatInterjectionContext,
  getPendingInterjections,
  markInterjectionsApplied
} = require('./controls');

// Optional web-search integration. If the module isn't present at runtime,
// agents with enableWebSearch=true will just run without web context.
let searchWeb = async () => ({ results: [], formatted: '', error: 'webSearch not available' });
try {
  ({ searchWeb } = require('../webSearch'));
} catch { /* noop */ }

// Per-roundtable streaming emitters — the SSE route picks these up.
const emitterRegistry = new Map();
// Per-run abort controllers: a cancel or the total timeout stops the agent in flight.
const runControllers = new Map();
const CANCELLED_ERROR = 'Cancelled by the chair';

const {
  assessModelParticipantReadiness,
  buildPinnedAgentPayload,
  callAgent,
  callAgentStreaming,
  callParticipant,
  isSystemicParticipantFailure,
  participantRouteKey
} = require('./participantCalls');

function withInterjectionContext(messages, interjections) {
  const context = formatInterjectionContext(interjections);
  if (!context) return messages;
  return [...messages, { role: 'user', content: context }];
}

function buildSynthesisRequest(question, transcript) {
  return `Original question: ${question}\n\n---\n\nPanel Discussion:\n\n${transcript}\n\n---\n\nAnswer the original question using the panel evidence. Preserve consensus, material dissent, evidence, and risks when the requested format permits. This verdict is advisory and must not claim that any action was approved or executed.\n\nOUTPUT CONTRACT: Every explicit format or length constraint in the original question is mandatory. If it requests an exact shape (for example, exactly two bullets), return exactly that shape and nothing else—no preamble, headings, appendix, or open-questions section.`;
}

async function recordAppliedInterjections(roundtableDoc, interjections, round, emitter) {
  if (!interjections.length) return [];
  await markInterjectionsApplied(roundtableDoc._id, interjections, round);
  if (emitter) {
    emitter.emit('chunk', {
      type: 'interjections-applied',
      round,
      count: interjections.length
    });
  }
  return interjections;
}

// ─── one round (all agents in order) ─────────────────────────────────────
async function executeRound(roundtableDoc, roundNum, agents, buildMessages, timeoutMs, emitter, options = {}) {
  const results = {};
  const failedRoutes = new Map();
  const participantCaller = options.callParticipantImpl || callParticipant;

  for (const agent of agents) {
    if (options.signal?.aborted) break;
    const routeKey = participantRouteKey(agent);
    const messages = buildMessages(agent, results);

    let webSearchResults = [];
    if (agent.enableWebSearch) {
      if (emitter) emitter.emit('chunk', { type: 'web-search-start', agentId: agent.agentId, round: roundNum });
      const searchResult = await searchWeb(roundtableDoc.question);
      webSearchResults = searchResult.results || [];
      if (searchResult.formatted) {
        messages.splice(messages.length - 1, 0, {
          role: 'user',
          content: require('../webSearch').untrustedSearchMessage(searchResult.formatted)
        });
      }
      if (emitter) emitter.emit('chunk', { type: 'web-search-done', agentId: agent.agentId, round: roundNum, resultCount: webSearchResults.length });
    }

    const runtime = String(agent.runtime || 'model').toLowerCase();
    if (emitter) emitter.emit('chunk', {
      type: 'turn-start', agentId: agent.agentId, round: roundNum,
      role: agent.role, model: agent.model, runtime
    });

    const priorFailure = failedRoutes.get(routeKey);
    const result = priorFailure
      ? {
          response: '',
          thinking: null,
          stats: { tokensPerSecond: null, latencyMs: 0 },
          error: `Skipped after shared route failure: ${priorFailure}`,
          target: null,
          hostName: null,
          runtime,
          runtimeRef: null,
          startedAt: new Date(),
          completedAt: new Date()
        }
      : await participantCaller(
          { ...agent, _round: roundNum },
          messages,
          timeoutMs,
          emitter,
          'turn',
          { roundtableId: String(roundtableDoc._id), round: roundNum, signal: options.signal }
        );

    if (!priorFailure && isSystemicParticipantFailure(result)) {
      failedRoutes.set(routeKey, result.error);
    }

    if (emitter) emitter.emit('chunk', { type: 'turn-done', agentId: agent.agentId, round: roundNum, stats: result.stats, error: result.error });

    const persistedTurn = {
      agentId: agent.agentId, role: agent.role, round: roundNum, model: agent.model,
      runtime, runtimeRef: result.runtimeRef || null,
      target: result.target, hostName: result.hostName,
      // Persist only the participant's final answer. Private reasoning is not
      // part of the Council contract and must never enter Mongo or transcripts.
      response: result.response, thinking: null, error: result.error,
      webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
      stats: result.stats, startedAt: result.startedAt, completedAt: result.completedAt
    };
    await Roundtable.updateOne(
      { _id: roundtableDoc._id },
      { $push: { turns: persistedTurn } }
    );
    await Roundtable.updateOne(
      { _id: roundtableDoc._id, 'panelConfig.agentId': agent.agentId },
      { $set: { 'panelConfig.$.resolvedTarget': result.target, 'panelConfig.$.resolvedHostName': result.hostName } }
    );

    results[agent.agentId] = result;
  }

  return results;
}

// ─── run: orchestrate the whole discussion ───────────────────────────────
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
    if (emitter) emitter.emit('chunk', { type: 'started', roundtableId, rounds: doc.rounds });

    const agents = doc.panelConfig.map((a) => a.toObject());
    const controller = new AbortController();
    runControllers.set(String(roundtableId), controller);
    const runOptions = { signal: controller.signal };
    const totalTimer = setTimeout(async () => {
      controller.abort();
      logger.error('Roundtable total timeout exceeded', { roundtableId });
      const totalDurationMs = Date.now() - startTime;
      const timeoutError = `Total timeout after ${DEFAULT_TOTAL_TIMEOUT_MS}ms`;
      const result = await Roundtable.updateOne(
        { _id: roundtableId, status: 'running' },
        { $set: { status: 'timeout', error: timeoutError, completedAt: new Date(), totalDurationMs } }
      );
      if (result?.modifiedCount > 0 && emitter) {
        emitter.emit('chunk', { type: 'done', status: 'timeout', error: timeoutError, totalDurationMs });
      }
    }, DEFAULT_TOTAL_TIMEOUT_MS);

    // Round 1 — blind
    const r1Interjections = await getPendingInterjections(roundtableId);
    if (emitter) emitter.emit('chunk', { type: 'round-start', round: 1, label: 'Initial Analysis' });
    // In a conversation each speaker hears those before it; a blind round keeps answers independent.
    const r1Results = await executeRound(doc, 1, agents, (agent, earlier) => withInterjectionContext([
      { role: 'system', content: withCouncilAdvisoryGuard(agent.systemPrompt) },
      { role: 'user', content: doc.question + (doc.turnOrder === 'conversation' ? spokenBefore(agents, earlier) : '') }
    ], r1Interjections), DEFAULT_TIMEOUT_MS, emitter, runOptions);
    // Cancelled or timed out: the status already says so.
    if (controller.signal.aborted) { clearTimeout(totalTimer); return; }
    await recordAppliedInterjections(doc, r1Interjections, 1, emitter);
    if (emitter) emitter.emit('chunk', { type: 'round-done', round: 1 });
    if (!Object.values(r1Results).some(result => String(result?.response || '').trim())) {
      throw new Error('Council stopped: no panelist returned a response. Review host readiness and retry.');
    }

    // Rounds 2..N — rebuttals
    if (doc.rounds >= 2) {
      doc = await Roundtable.findById(roundtableId);
      if (doc.status !== 'running') { clearTimeout(totalTimer); return; }

      for (let roundNum = 2; roundNum <= doc.rounds; roundNum += 1) {
        const previousTurns = doc.turns.filter((t) => t.round === roundNum - 1);
        const roundInterjections = await getPendingInterjections(roundtableId);
        if (emitter) emitter.emit('chunk', { type: 'round-start', round: roundNum, label: `Rebuttal Round ${roundNum}` });

        await executeRound(doc, roundNum, agents, (agent) => {
          const otherResponses = previousTurns
            .filter((t) => t.agentId !== agent.agentId && t.response)
            .map((t) => `**${t.role}:**\n${t.response}`)
            .join('\n\n');
          return withInterjectionContext([
            { role: 'system', content: withCouncilAdvisoryGuard(agent.systemPrompt) },
            { role: 'user', content: doc.question },
            { role: 'assistant', content: r1Results[agent.agentId]?.response || '' },
            { role: 'user', content: REBUTTAL_PREAMBLE + otherResponses + '\n\n---\nNow provide your rebuttal.' }
          ], roundInterjections);
        }, DEFAULT_TIMEOUT_MS, emitter, runOptions);

        await recordAppliedInterjections(doc, roundInterjections, roundNum, emitter);
        if (emitter) emitter.emit('chunk', { type: 'round-done', round: roundNum });
        doc = await Roundtable.findById(roundtableId);
        if (doc.status !== 'running') { clearTimeout(totalTimer); return; }
      }
    }

    // Synthesis
    doc = await Roundtable.findById(roundtableId);
    if (doc.status !== 'running') { clearTimeout(totalTimer); return; }

    const allTurns = doc.turns;
    const synthesisInterjections = await getPendingInterjections(roundtableId);
    const transcriptForSynthesis = allTurns
      .map((t) => `[Round ${t.round}] ${t.role} (${t.model}):\n${t.response || t.error || 'No response'}`)
      .join('\n\n---\n\n');

    const synthesizer = doc.synthesizerConfig.toObject ? doc.synthesizerConfig.toObject() : doc.synthesizerConfig;
    const synthMessages = withInterjectionContext([
      { role: 'system', content: withCouncilAdvisoryGuard(synthesizer.systemPrompt) },
      { role: 'user', content: buildSynthesisRequest(doc.question, transcriptForSynthesis) }
    ], synthesisInterjections);

    if (emitter) emitter.emit('chunk', { type: 'synthesis-start', model: synthesizer.model });

    // The verdict comes from the synthesizer model, or from the chair agent when one presides.
    const synthResult = await callParticipant(
      { agentId: synthesizer.agentId || 'synthesizer', role: synthesizer.agentId ? 'Chair' : 'Synthesizer',
        runtime: synthesizer.runtime || 'model', model: synthesizer.model, systemPrompt: synthesizer.systemPrompt, _round: 0 },
      synthMessages, DEFAULT_TIMEOUT_MS, emitter, 'synthesis',
      { roundtableId: String(doc._id), round: 0, phase: 'synthesis', signal: controller.signal }
    );

    if (emitter) emitter.emit('chunk', { type: 'synthesis-done', stats: synthResult.stats, error: synthResult.error });
    await recordAppliedInterjections(doc, synthesisInterjections, 0, emitter);
    clearTimeout(totalTimer);

    doc = await Roundtable.findById(roundtableId);
    if (doc.status !== 'running') return;

    if (synthResult.error || !String(synthResult.response || '').trim()) {
      throw new Error(`Council synthesis failed: ${synthResult.error || 'no response returned'}`);
    }

    const totalDurationMs = Date.now() - startTime;
    const decisionStatus = doc.governance?.requireApproval ? 'awaiting_approval' : 'advisory';
    const completedAt = new Date();
    await Roundtable.updateOne(
      { _id: roundtableId, status: 'running' },
      { $set: {
        synthesis: {
          model: synthesizer.model, target: synthResult.target, hostName: synthResult.hostName,
          response: synthResult.response, thinking: null, error: synthResult.error,
          stats: synthResult.stats, startedAt: synthResult.startedAt, completedAt: synthResult.completedAt
        },
        'synthesizerConfig.resolvedTarget': synthResult.target,
        'synthesizerConfig.resolvedHostName': synthResult.hostName,
        'governance.decisionStatus': decisionStatus,
        'governance.requestedAt': doc.governance?.requireApproval ? completedAt : null,
        status: 'completed', totalDurationMs, completedAt
      } }
    );

    doc = await Roundtable.findById(roundtableId);
    logger.info('Roundtable completed', { roundtableId, totalDurationMs, turns: allTurns.length });
    if (emitter) emitter.emit('chunk', {
      type: 'done', status: 'completed', totalDurationMs, decisionStatus
    });
  } catch (err) {
    logger.error('Roundtable failed', { roundtableId, error: err.message });
    // A cancelled or timed-out run keeps that status.
    const result = await Roundtable.updateOne(
      { _id: roundtableId, status: { $in: ['pending', 'running'] } },
      { $set: { status: 'failed', error: err.message, totalDurationMs: Date.now() - startTime, completedAt: new Date() } }
    ).catch(() => null);
    if (emitter && result?.modifiedCount > 0) emitter.emit('chunk', { type: 'done', status: 'failed', error: err.message });
  } finally {
    emitterRegistry.delete(roundtableId);
    runControllers.delete(String(roundtableId));
  }
}

async function createRoundtable(options) {
  const {
    question,
    rounds = 2,
    panel = DEFAULT_PANEL,
    synthesizer = DEFAULT_SYNTHESIZER,
    source = 'api',
    tags = [],
    governance = {},
    turnOrder
  } = options;

  const mergedPanel = normalizePanel(panel);
  const mergedSynthesizer = normalizeSynthesizer(synthesizer, mergedPanel);

  return Roundtable.create({
    question,
    rounds: Math.min(Math.max(rounds, 1), 3),
    panelConfig: mergedPanel,
    synthesizerConfig: mergedSynthesizer,
    turnOrder: normalizeTurnOrder(turnOrder),
    governance: {
      requireApproval: Boolean(governance.requireApproval),
      decisionStatus: 'deliberating'
    },
    status: 'pending',
    source,
    tags
  });
}

// ─── stale session reconciliation ────────────────────────────────────────
// A Council session only advances inside the process that started it. When
// Core restarts (deploys, crashes) while a session is pending/running, nothing
// ever flips its status again and the UI shows RUNNING forever. Any session
// that has not been touched for longer than the total ceiling cannot still be
// alive, so it is closed as failed with an explicit reason.
const STALE_GRACE_MS = 60 * 1000;
const STALE_ERROR = 'Council orchestrator stopped before this session finished (Core restarted or the session exceeded its ceiling). Start a new session.';

function staleCutoff(now = Date.now(), maxAgeMs = DEFAULT_TOTAL_TIMEOUT_MS + STALE_GRACE_MS) {
  return new Date(now - maxAgeMs);
}

async function reconcileStaleRoundtables({ now = Date.now(), maxAgeMs } = {}) {
  const cutoff = staleCutoff(now, maxAgeMs);
  const filter = {
    status: { $in: ['pending', 'running'] },
    updatedAt: { $lt: cutoff }
  };
  const activeHere = [...emitterRegistry.keys()].map(String);
  if (activeHere.length) filter._id = { $nin: activeHere };
  const result = await Roundtable.updateMany(filter, {
    $set: { status: 'failed', error: STALE_ERROR, completedAt: new Date(now) }
  });
  const reconciled = Number(result?.modifiedCount || 0);
  if (reconciled > 0) {
    logger.warn('Closed stale Council sessions left running by a previous process', { reconciled, cutoff });
  }
  return { reconciled, cutoff };
}

/** Stop a pending or running council: mark it cancelled, then abort the agent in flight. */
async function cancelRoundtable(roundtableId) {
  const doc = await Roundtable.findOneAndUpdate(
    { _id: roundtableId, status: { $in: ['pending', 'running'] } },
    { $set: { status: 'cancelled', error: CANCELLED_ERROR, completedAt: new Date() } },
    { new: true }
  );
  if (!doc) {
    const err = new Error('This council is not running.');
    err.status = 409;
    throw err;
  }
  runControllers.get(String(roundtableId))?.abort();
  emitterRegistry.get(String(roundtableId))?.emit('chunk', { type: 'done', status: 'cancelled', error: CANCELLED_ERROR });
  return doc;
}

async function getRoundtable(id) {
  await reconcileStaleRoundtables().catch(() => {});
  return Roundtable.findById(id);
}

async function listRoundtables({ limit = 20, skip = 0 } = {}) {
  await reconcileStaleRoundtables().catch(() => {});
  const [docs, total] = await Promise.all([
    Roundtable.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Roundtable.countDocuments({})
  ]);
  return { docs, total };
}

module.exports = {
  callAgent,
  buildPinnedAgentPayload,
  assessModelParticipantReadiness,
  isSystemicParticipantFailure,
  participantRouteKey,
  callAgentStreaming,
  buildSynthesisRequest,
  executeRound,
  runRoundtable,
  createRoundtable,
  cancelRoundtable,
  getRoundtable,
  listRoundtables,
  reconcileStaleRoundtables,
  STALE_ERROR,
  emitterRegistry
};

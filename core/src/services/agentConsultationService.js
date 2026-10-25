'use strict';

const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (message, code = 'CONSULTATION_INVALID') => Object.assign(new Error(message), { code });
const scope = { packId: 'personal_operator', scopeId: 'personal' };

// A replaceable harness asks Core to consult an installed native collaborator.
// Requests, dispatch fences, answers and evidence live in canonical conversations.
// A lost response NEVER authorizes another launch, even after a process restart.
function createConsultations({ conversations, execute, observe, env = process.env } = {}) {
  conversations ||= require('./surfaceConversationService').forSurface('agent-consultations');
  const native = require('../../surfaces/household/personal-continuity');
  observe ||= native.createNestorClient({ env });
  execute ||= require('../../surfaces/household/conversation-agent').createAgentClient({ env, continuity: observe });
  const pending = new Map();
  const query = sessionId => ({ sessionId, ...scope });
  const view = row => ({ authority: 'agentx.core', requestId: row.consultation.requestId, member: row.agentId,
    state: row.consultation.state, sessionId: row.sessionId,
    sessionKey: row.consultation.sessionKey, runId: row.consultation.runId || null,
    ...(row.consultation.reason ? { reason: row.consultation.reason } : {}),
    ...(row.consultation.state === 'completed' ? { resultAvailable: true } : {}),
    instruction: 'Poll this same requestId. Never launch a replacement for a running or uncertain request.' });
  async function result(row) {
    let turn = await conversations.getTurn({ ...query(row.sessionId), traceId: row.consultation.requestId });
    if (turn && !turn.toolEvidence?.toolChecks && row.consultation.runId) {
      try {
        const native = await observe({ operation: 'turn', sessionKey: row.consultation.sessionKey, runId: row.consultation.runId });
        if (native.ok === true && native.authority === 'openclaw.nestor' && native.operation === 'turn'
          && native.run?.sessionKey === row.consultation.sessionKey && native.run.runId === row.consultation.runId
          && native.run.status === 'completed' && native.toolChecks?.status === 'observed'
          && native.toolChecks.runId === row.consultation.runId && Array.isArray(native.toolChecks.completedTools)) {
          // Supplement old results from the exact native transcript. Never
          // promote an unknown domain receipt into a verified business result.
          turn = await conversations.updateTurn({ ...query(row.sessionId), traceId: row.consultation.requestId },
            { $set: { toolEvidence: { ...turn.toolEvidence, toolChecks: native.toolChecks } } }) || turn;
        }
      } catch { /* A native outage does not hide the retained original answer. */ }
    }
    return { ...view(row), ...(turn ? { answer: turn.replyText, evidence: turn.toolEvidence } : {}) };
  }
  async function complete(row, answer, evidence) {
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 16000) throw fail('Native answer is unavailable or exceeds the consultation budget.');
    await conversations.recordTurn({ ...query(row.sessionId), traceId: row.consultation.requestId,
      inputText: row.consultation.question, replyText: answer, toolEvidence: evidence, outcome: 'answered' },
    { sessionPatch: { 'consultation.state': 'completed' } });
  }
  async function launch(row) {
    try {
      const reply = await execute({ session: row, text: row.consultation.question, channel: 'text', history: [],
        instructions: 'The owner\'s assistant consults you. Use your installed native tools, scope and approval rules. Answer the complete request in its language. Never claim actions without receipts. Do not contact anyone unless the request explicitly authorizes it.',
        onStarted: async (sessionKey, runId) => {
          if (sessionKey !== row.consultation.sessionKey || !/^resp_[a-f0-9-]{36}$/.test(runId || '')) throw fail('Native consultation identity mismatch.');
          await conversations.updateSession({ ...query(row.sessionId), 'consultation.state': 'dispatching' },
            { $set: { 'consultation.state': 'running', 'consultation.runId': runId } });
        } });
      const current = await conversations.getSession(query(row.sessionId));
      if (reply.sessionKey !== current.consultation.sessionKey || reply.runId !== current.consultation.runId || reply.interrupted) {
        throw fail('Native consultation did not return its exact result.');
      }
      await complete(current, reply.text, reply.tools);
    } catch {
      await conversations.updateSession({ ...query(row.sessionId), 'consultation.state': { $in: ['dispatching', 'running'] } },
        { $set: { 'consultation.state': 'uncertain', 'consultation.reason': 'native_result_not_proven' } });
    }
  }
  async function status(row) {
    if (row.consultation.state === 'completed') return result(row);
    if (pending.has(row.sessionId)) {
      let timer;
      try { await Promise.race([pending.get(row.sessionId), new Promise(resolve => { timer = setTimeout(resolve, 20000); })]); }
      finally { clearTimeout(timer); }
      row = await conversations.getSession(query(row.sessionId));
      return row.consultation.state === 'completed' ? result(row) : view(row);
    }
    // Read-only reconciliation; absence of a receipt is never proof of failure.
    try {
      let runId = row.consultation.runId;
      if (!runId) {
        const attempt = await observe({ operation: 'work_attempt', isolatedConsultation: true, sessionKey: row.consultation.sessionKey });
        if (attempt.sessionKey !== row.consultation.sessionKey || !/^resp_[a-f0-9-]{36}$/.test(attempt.runId || '')) return view(row);
        runId = attempt.runId;
        row = await conversations.updateSession(query(row.sessionId), { $set: { 'consultation.runId': runId } });
      }
      const receipt = await observe({ operation: 'turn', sessionKey: row.consultation.sessionKey, runId });
      if (receipt.authority !== 'openclaw.nestor' || receipt.run?.sessionKey !== row.consultation.sessionKey
        || receipt.run.runId !== runId) return view(row);
      if (receipt.run.status === 'completed' && receipt.answer?.runId === runId && receipt.answer.status === 'ready'
        && receipt.answerObservation === undefined) {
        await complete(row, receipt.answer.text, { authority: `openclaw/${row.agentId}`, runId,
          run: receipt.run, receipts: receipt.receipts || [], toolChecks: receipt.toolChecks || null });
        return result(await conversations.getSession(query(row.sessionId)));
      }
      if (receipt.run.status === 'failed') {
        row = await conversations.updateSession(query(row.sessionId), { $set: { 'consultation.state': 'failed' } });
      }
    } catch { /* Keep the original fence when native evidence is unavailable. */ }
    return view(row);
  }
  async function operate(input = {}) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.requestId || '') || !['request', 'status'].includes(input.action)) throw fail('Use request/status with a stable UUID requestId.');
    const sessionId = hash(input.requestId.toLowerCase()).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    let row = await conversations.getSession(query(sessionId));
    if (input.action === 'status') {
      if (!row) throw fail('No such consultation.', 'CONSULTATION_NOT_FOUND');
      return status(row);
    }
    if (!['secretary', 'comptable', 'leadx', 'cloudx', 'main'].includes(input.member)
      || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 8000) throw fail('Choose an installed collaborator and a complete question of at most 8000 characters.');
    const question = input.question.trim();
    if (!row) {
      const catalog = await observe({ operation: 'agents' });
      if (!catalog.agents?.some(agent => agent.id === input.member && !agent.internal)) throw fail('The requested collaborator is not installed.', 'CONSULTATION_MEMBER_UNAVAILABLE');
      row = await conversations.ensureSession({ ...query(sessionId),
        agentId: input.member, modeId: 'standard', status: 'active', label: `Consultation: ${input.member}`,
        consultation: { requestId: input.requestId.toLowerCase(), question, state: 'received', sessionKey: `agent:${input.member}:household:direct:${sessionId}` } });
    }
    if (row.agentId !== input.member || row.consultation.question !== question) throw fail('This requestId already belongs to another request.', 'CONSULTATION_ID_CONFLICT');
    const claimed = await conversations.updateSession({ ...query(sessionId), 'consultation.state': 'received' },
      { $set: { 'consultation.state': 'dispatching' } });
    if (!claimed) return status(await conversations.getSession(query(sessionId)));
    const work = launch(claimed).finally(() => pending.delete(sessionId));
    pending.set(sessionId, work);
    return view(claimed);
  }
  return { operate };
}
let installed;
module.exports = { createConsultations, operate: input => (installed ||= createConsultations()).operate(input) };

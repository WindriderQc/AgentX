'use strict';

const { randomUUID } = require('node:crypto');
const { hash, fail, notFound, LIMITS } = require('./contract');
const { isNativeToolCallId } = require('../../../../shared/nativeToolCallId.cjs');
const { summarizeToolEvidence } = require('../conversations/toolEvidenceReferences');

// Native guardian reads use the existing server catalogue and content owner.
// Reserve the exact native call before reading: a lost result is never replayed.
function createGuardianReads({ repo, binding, session, query, conversations, tools = () => null,
  occupied = async () => false, now = () => new Date() }) {
  async function eligible(row, context) {
    if (row.erased || row.mode !== 'native' || row.entryPolicy !== 'main-first/v1' || row.foreground !== 'guardian'
        || !['received', 'queued', 'running'].includes(row.state) || row.result
        || row.guardian?.state !== 'running' || ['main', 'family'].includes(context.agentId)
        || row.guardian.agentId !== context.agentId || row.guardian.runId !== context.runId
        || row.guardian.sessionKey !== context.sessionKey
        || context.sessionKey !== `agent:${context.agentId}:household:direct:${row.guardian.sessionId}`
        || !row.primary?.relayFor) throw notFound();
    await session(row.sessionId);
    const turn = await conversations.getTurn({ ...query(row.sessionId), traceId: row.turnId });
    if (!turn || turn.outcome !== 'pending' || hash(turn.inputText) !== row.requestSha256
        || await occupied(row) !== true) throw notFound();
  }
  function catalogue() {
    const set = tools();
    if (!set) throw fail('CONVERSATION_WORK_GUARDIAN_READ_DENIED', 'No guardian reads are enabled.', 403);
    return set;
  }
  async function definitions(context) {
    const row = await binding(context, 'guardian'); await eligible(row, context);
    const set = tools();
    return { authority: 'core.conversation-works', id: row._id,
      definitions: set?.definitions || [], instructions: set?.instructions || 'No guardian reads are enabled.',
      maxDistinctReads: set ? set.maxRounds * set.maxCallsPerRound : 0, maxCallIdentities: LIMITS.tools };
  }
  async function answer(row, entry, nativeContext) {
    const result = entry.state === 'completed' ? await repo.read(row, entry.payloadRef) : undefined;
    // Payload retrieval can outlive erasure, cancellation or Main's release.
    // Never authorize delivery from the snapshot taken before that await.
    const fresh = await repo.get(row._id), original = fresh?.guardian?.reads?.find(value => value.id === entry.id);
    if (!fresh || !original || original.fingerprint !== entry.fingerprint || original.state !== entry.state) throw notFound();
    await session(fresh.sessionId);
    if (nativeContext) await eligible(fresh, nativeContext);
    return { authority: 'core.conversation-works', id: row._id,
      receipt: { id: entry.id, tool: entry.tool, agentId: entry.agentId, sessionKey: entry.sessionKey,
        runId: entry.runId, callId: entry.callId, status: entry.state === 'completed' ? entry.status : 'uncertain', at: entry.at },
      ...(entry.state === 'completed' && { result }) };
  }
  async function execute(context, input, callId) {
    const row = await binding(context, 'guardian'); await eligible(row, context);
    if (!isNativeToolCallId(callId) || !input || Object.keys(input).some(key => !['name', 'args'].includes(key))) {
      throw fail('CONVERSATION_WORK_GUARDIAN_READ_INVALID', 'An exact native call and bounded read are required.');
    }
    const set = catalogue(), accepted = set.accept({ function: { name: input.name, arguments: input.args } });
    if (!accepted) throw fail('CONVERSATION_WORK_GUARDIAN_READ_INVALID', 'This read is not in the server guardian catalogue.');
    const id = hash(JSON.stringify([context.agentId, context.sessionKey, context.runId, callId]));
    const fingerprint = hash(JSON.stringify([accepted.name, Object.entries(accepted.args).sort()]));
    const token = randomUUID();
    const claimed = await repo.mutate(row._id, async current => {
      await eligible(current, context);
      const reads = current.guardian.reads || [], previous = reads.find(entry => entry.id === id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw fail('CONVERSATION_WORK_GUARDIAN_READ_CONFLICT', 'The original read arguments cannot change.', 409);
        return null;
      }
      // Cache equal reads across native calls, but retain every answered call
      // as an immutable alias: its identity can never acquire different args.
      const original = reads.find(entry => !entry.reference && entry.fingerprint === fingerprint);
      if (reads.length >= LIMITS.tools) throw fail('CONVERSATION_WORK_GUARDIAN_READ_BUDGET', 'The guardian call journal is full.', 409);
      if (original) return { fields: { guardian: { ...current.guardian, reads: [...reads, {
        id, fingerprint, reference: original.id, tool: original.tool, agentId: context.agentId,
        sessionKey: context.sessionKey, runId: context.runId, callId, at: now(), state: 'reference'
      }] } }, event: 'guardian_read_reference' };
      if (reads.some(entry => !entry.reference && entry.state !== 'completed')) throw fail('CONVERSATION_WORK_GUARDIAN_READ_UNCERTAIN', 'Reconcile the original native call; no replacement read is permitted.', 409);
      if (reads.filter(entry => !entry.reference).length >= set.maxRounds * set.maxCallsPerRound
          || current.tools.length >= LIMITS.tools) throw fail('CONVERSATION_WORK_GUARDIAN_READ_BUDGET', 'The guardian read budget is exhausted.', 409);
      return { fields: { guardian: { ...current.guardian, reads: [...reads, { id, fingerprint, token,
        tool: accepted.name, agentId: context.agentId, sessionKey: context.sessionKey, runId: context.runId,
        callId, at: now(), state: 'reading' }] } }, event: 'guardian_read_reserved' };
    });
    const entry = claimed.guardian.reads.find(value => value.id === id);
    if (entry.reference) {
      const original = claimed.guardian.reads.find(value => value.id === entry.reference && !value.reference);
      if (!original || original.fingerprint !== fingerprint) throw notFound();
      return { ...await answer(claimed, original, context), reused: true, requestedCallId: callId };
    }
    if (entry.token !== token) return answer(claimed, entry, context);
    // Cancellation, erasure, release or an uncertain owner between reservation
    // and execution fails closed. Its original reservation remains unreplayable.
    const current = await binding(context, 'guardian'); await eligible(current, context);
    const result = await set.execute({ function: { name: accepted.name, arguments: accepted.args } });
    if (!result || !['completed', 'failed', 'refused'].includes(result.receipt?.status)
        || JSON.stringify(result).length > 10000) throw fail('CONVERSATION_WORK_GUARDIAN_READ_UNCERTAIN', 'The original read has no bounded result.', 503);
    const saved = await repo.mutate(row._id, async (latest, fence) => {
      await eligible(latest, context);
      const owned = latest.guardian.reads?.find(value => value.id === id);
      if (!owned || owned.token !== token || owned.state !== 'reading') throw notFound();
      const payloadRef = await repo.payload(latest, result, fence);
      const completed = { ...owned, state: 'completed', status: result.receipt.status, payloadRef };
      return { fields: { guardian: { ...latest.guardian, reads: latest.guardian.reads.map(value => value.id === id ? completed : value) },
        tools: [...latest.tools, { id, tool: 'guardian.' + accepted.name, role: 'guardian', fingerprint,
          payloadRef, runId: context.runId, callId, at: owned.at, status: result.receipt.status }] }, event: 'guardian_read_result' };
    });
    return answer(saved, saved.guardian.reads.find(value => value.id === id), context);
  }
  async function context(row) {
    const reads = [];
    for (const entry of row.guardian?.reads || []) {
      if (entry.reference) {
        reads.push({ id: entry.id, tool: entry.tool, agentId: entry.agentId, sessionKey: entry.sessionKey,
          runId: entry.runId, callId: entry.callId, at: entry.at, status: 'reference', originalReceiptId: entry.reference });
        continue;
      }
      const value = await answer(row, entry), result = value.result;
      delete value.result;
      reads.push({ ...value.receipt, ...(result && { data: { $evidence: { ref: `${row._id}/${entry.id}`,
        sha256: hash(JSON.stringify(result)), chars: JSON.stringify(result).length,
        summary: summarizeToolEvidence('guardian.' + entry.tool, result) } } }) });
    }
    if (!await repo.get(row._id)) throw notFound();
    await session(row.sessionId);
    return reads;
  }
  return { definitions, execute, context };
}
module.exports = { createGuardianReads };

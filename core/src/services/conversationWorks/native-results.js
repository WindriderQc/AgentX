'use strict';

const { randomUUID } = require('node:crypto');
const { hash, fail, notFound, LIMITS } = require('./contract');

// Trusted native adapter only: this is deliberately absent from the model and
// browser routes. The original attempt owns its final transcript and receipts.
function createNativeResultReceiver({ repo, session, now }) {
  return async function publishNative(id, evidence) {
    const row = await repo.get(id);
    if (!row || row.classification !== 'native_read' || !row.attempt) throw notFound();
    await session(row.sessionId);
    const { attempt } = row, { run, answer, toolChecks } = evidence || {};
    if (run?.runId !== attempt.runId || run.sessionKey !== attempt.sessionKey || run.status !== 'completed'
        || answer?.runId !== attempt.runId || answer.status !== 'ready' || evidence.answerObservation !== undefined
        || typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > LIMITS.result
        || toolChecks?.status !== 'observed' || toolChecks.runId !== attempt.runId
        || !Array.isArray(toolChecks.completedTools) || !toolChecks.completedTools.length || toolChecks.loop) {
      throw fail('CONVERSATION_WORK_NATIVE_RESULT_INVALID', 'The exact completed native answer and tool evidence are required.', 409);
    }
    const receiptId = hash(attempt.id + '\n' + attempt.runId + '\nnative_answer');
    const result = { kind: 'answer', text: answer.text.trim(), receiptIds: [receiptId] };
    const fingerprint = hash(JSON.stringify(result));
    const saved = await repo.mutate(id, async (current, fence) => {
      if (current.attempt?.id !== attempt.id || current.attempt.runId !== attempt.runId) throw notFound();
      if (current.result) {
        if (current.result.fingerprint !== fingerprint) throw fail('CONVERSATION_WORK_RESULT_CONFLICT', 'The result was already published.', 409);
        return null;
      }
      if (!['running', 'dispatching', 'uncertain'].includes(current.state)) throw notFound();
      return { fields: { state: 'result_ready', reason: '', tools: [...current.tools, {
        id: receiptId, tool: 'native.consultation', status: 'observed', runId: attempt.runId, at: now(),
        payloadRef: await repo.payload(current, evidence, fence) }],
        result: { version: 1, kind: result.kind, fingerprint, payloadRef: await repo.payload(current, result, fence), publishedAt: now() },
        delivery: { id: randomUUID(), resultVersion: 1, state: 'available', receipts: [] } }, event: 'native_result_published' };
    });
    return { authority: 'core.conversation-works', published: true, id: saved._id,
      resultVersion: saved.result.version, deliveryId: saved.delivery.id };
  };
}
module.exports = { createNativeResultReceiver };

'use strict';

const { nativePerformedBy } = require('./native-attribution');

// Adapt only an answer already received by Core for the original Main attempt.
// No native call, identity choice, permission or second result owner lives here.
async function nativePrimaryReply(request) {
  if (typeof request.readPrimaryWork !== 'function') return null;
  const received = await request.readPrimaryWork();
  if (!received) { await request.requirePrimaryRelay?.(); return null; }
  if (received.statusOnly) return require('./native-work-acceptance').nativeWorkAcknowledgment({ ...request, model: undefined });
  const { result, evidence, attempt } = received;
  request.signal?.throwIfAborted();
  request.onDelta?.(result.text);
  await request.onSettled?.();
  return { text: result.text, backend: 'openclaw', sessionKey: attempt.sessionKey, runId: attempt.runId,
    tools: { status: 'observed', authority: 'openclaw/main', runId: attempt.runId,
      primaryResult: { workId: received.workId, version: received.version, fingerprint: received.fingerprint },
      receipts: evidence.receipts || [], run: evidence.run, toolChecks: evidence.toolChecks,
      performedBy: nativePerformedBy(evidence, 'main', attempt.runId),
      ...(evidence.answer?.deliveredBy && { deliveredBy: evidence.answer.deliveredBy }) },
    metadata: { model: evidence.run.model || '', provider: evidence.run.provider || '', usage: evidence.run.usage || null,
      routingSource: 'openclaw/main', runId: attempt.runId, primaryWorkId: received.workId } };
}

module.exports = { nativePrimaryReply };

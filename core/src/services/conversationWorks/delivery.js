'use strict';

const { ACTIVE, LIMITS, fail, notFound } = require('./contract');

function createWorkDelivery(works) {
  async function projection(row) {
    const result = row.result ? await works.repo.read(row, row.result.payloadRef) : null;
    return { id: row._id, turnId: row.turnId, sessionId: row.sessionId, state: row.state,
      revision: row.revision, receivedAt: row.receivedAt, updatedAt: row.updatedAt,
      classification: row.classification, guardianStatus: row.guardian?.state || 'unknown', sequence: row.sequence, reason: row.reason || '',
      controllable: !row.attempt && ['received', 'queued', 'paused'].includes(row.state),
      result: result && result.kind !== 'no_work' ? { ...result, version: row.result.version,
        deliveryId: row.delivery.id, presentation: row.delivery.state } : null,
      // A context payload is never a browser projection.
      pending: (ACTIVE.includes(row.state) || ['pending', 'running', 'uncertain'].includes(row.guardian?.state)) && !row.result };
  }
  async function snapshot(sessionId, cursor = 0) {
    await works.session(sessionId);
    if (!Number.isSafeInteger(Number(cursor)) || Number(cursor) < 0) throw fail('CONVERSATION_WORK_CURSOR_INVALID', 'Invalid work cursor.');
    const rows = await works.repo.find({ sessionId, sequence: { $gt: Number(cursor) } }, 65, { sequence: 1, _id: 1 });
    const selected = rows.slice(0, 64);
    const events = selected.flatMap(row => row.events.filter(event => event.sequence > Number(cursor))
      .map(event => ({ ...event, workId: row._id }))).sort((a, b) => a.sequence - b.sequence);
    return { authority: 'core.conversation-works', items: await Promise.all(selected.map(projection)),
      events, cursor: selected.at(-1)?.sequence || Number(cursor), hasMore: rows.length > 64,
      snapshotRequired: selected.some(row => row.events.length === LIMITS.events && row.events[0].sequence > Number(cursor)) };
  }
  async function receipt(sessionId, deliveryId, input) {
    await works.session(sessionId);
    const [row] = await works.repo.find({ sessionId, 'delivery.id': deliveryId }, 1);
    if (!row) throw notFound();
    if (!input || Object.keys(input).some(key => !['stage', 'resultVersion', 'sequence', 'deviceSession', 'claimToken'].includes(key))
      || !['displayed', 'claim', 'replay', 'started', 'completed', 'interrupted', 'deferred'].includes(input.stage)
      || input.resultVersion !== row.result.version || !Number.isSafeInteger(input.sequence) || input.sequence < 1
      || !/^[a-zA-Z0-9-]{16,80}$/.test(input.deviceSession || '')) throw fail('CONVERSATION_WORK_PRESENTATION_INVALID', 'A versioned presentation receipt is required.');
    const { randomUUID } = require('node:crypto');
    const saved = await works.repo.mutate(row._id, current => {
      const delivery = { ...current.delivery };
      const last = delivery.receipts.filter(item => item.deviceSession === input.deviceSession).at(-1);
      if (last && input.sequence <= last.sequence) {
        if (last.sequence === input.sequence && last.stage === input.stage) return null;
        throw fail('CONVERSATION_WORK_PRESENTATION_CONFLICT', 'A receipt sequence was already used.', 409);
      }
      if (input.stage === 'claim' || input.stage === 'replay') {
        if (input.stage !== 'replay' && !['available', 'displayed', 'deferred'].includes(delivery.state)) throw fail('CONVERSATION_WORK_PRESENTATION_HELD', 'The result already has a presentation owner.', 409);
        delivery.state = 'claimed'; delivery.claimToken = randomUUID(); delivery.deviceSession = input.deviceSession;
      } else if (['started', 'completed', 'interrupted', 'deferred'].includes(input.stage)) {
        if (delivery.deviceSession !== input.deviceSession || input.claimToken !== delivery.claimToken
          || !['claimed', 'started'].includes(delivery.state)
          || input.stage === 'completed' && delivery.state !== 'started') throw fail('CONVERSATION_WORK_PRESENTATION_CONFLICT', 'The exact presentation owner is required.', 409);
        delivery.state = input.stage;
        if (input.stage === 'deferred') { delete delivery.claimToken; delete delivery.deviceSession; }
      } else if (delivery.state === 'available') delivery.state = 'displayed';
      delivery.receipts = [...delivery.receipts, { ...input, at: new Date() }].slice(-64);
      return { fields: { delivery }, event: 'presentation_' + input.stage };
    });
    return { authority: 'core.conversation-works', id: deliveryId, state: saved.delivery.state,
      ...(['claim', 'replay'].includes(input.stage) ? { claimToken: saved.delivery.claimToken } : {}) };
  }
  return { snapshot, receipt, projection };
}
module.exports = { createWorkDelivery };

'use strict';

const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { acknowledged } = require('../conversations/writeFence');
const { OWNER } = require('./contract');

// This owner dispatches one native run. It does not implement a model/tool
// loop. The durable gate has no timeout takeover: a lost dispatch is observed
// through its exact native session before another work is admitted.
function createWorkObserver({ works, execute, prepare = async value => value, observe, receive = async () => null,
  agentFor = () => env.PERSONAL_CONVERSATION_WORK_AGENT_ID, env = process.env, logger, intervalMs = 1000 }) {
  let running = false, timer, closed = false;
  const gate = () => mongoose.connection.collection('conversation_work_dispatch');
  const clear = (id, processId) => gate().updateOne({ _id: OWNER, workId: id, ...(processId && { processId }) }, { $set: { workId: null },
    $unset: { claimedAt: '', processId: '', phase: '', attempt: '' } }, acknowledged);

  async function reconcile(row) {
    if (!row) return;
    if (!row.attempt) { if (['completed', 'failed', 'cancelled'].includes(row.state)) await clear(row._id); return; }
    if (row.attempt.settledAt) { await clear(row._id); if (!row.erased) await works.finalize(row); return; }
    let evidence;
    try { evidence = await observe(row.attempt); }
    catch { return; }
    if (row.erased) {
      if (evidence?.run?.sessionKey === row.attempt.sessionKey
          && (!row.attempt.runId || evidence.run.runId === row.attempt.runId)
          && ['completed', 'failed'].includes(evidence.run.status)) await clear(row._id);
      return;
    }
    if (/^resp_[a-f0-9-]{36}$/.test(evidence?.runId || '') && !row.attempt.runId
        && (evidence.sessionKey === row.attempt.sessionKey || evidence.run?.sessionKey === row.attempt.sessionKey)
        && (!evidence.run || evidence.run.runId === evidence.runId)) row = await works.repo.mutate(row._id, current => ({
      fields: { attempt: { ...current.attempt, runId: evidence.runId } }, event: 'native_reconciled' }));
    const native = evidence?.run;
    if (native?.sessionKey !== row.attempt.sessionKey || native.runId !== row.attempt.runId
      || !['completed', 'failed'].includes(native.status)) {
      if (row.state !== 'uncertain' && row.state !== 'result_ready') await works.repo.mutate(row._id, () => ({
        fields: { state: 'uncertain', reason: 'native_result_not_proven' }, event: 'dispatch_uncertain' }));
      return;
    }
    // A yielded parent has ended; its specialist may still be working. Keep
    // the same dispatch owner until the original requester answer is received.
    const received = await receive({ row, evidence });
    if (received?.pending) return;
    const workId = row._id;
    row = await works.repo.get(workId);
    if (!row) { await clear(workId); return; }
    await works.repo.mutate(row._id, current => ({ fields: {
      state: current.result ? 'completed' : 'failed', reason: current.result ? '' : 'native_result_not_published',
      attempt: { ...current.attempt, settledAt: new Date(), terminal: native.status } }, event: 'native_settled' }));
    await clear(row._id);
    await works.finalize(await works.repo.get(row._id));
  }

  async function run(row) {
    const processId = randomUUID();
    const id = randomUUID(), sessionId = randomUUID(), agentId = agentFor(row);
    const namespace = row.classification === 'native_read' ? 'work' : 'direct';
    const attempt = { id, sessionId, agentId, sessionKey: `agent:${agentId}:household:${namespace}:${sessionId}`, dispatchedAt: new Date() };
    try { await gate().updateOne({ _id: OWNER }, { $setOnInsert: { workId: null } }, { ...acknowledged, upsert: true }); }
    catch (cause) { if (cause.code !== 11000) throw cause; }
    const claim = await gate().updateOne({ _id: OWNER, workId: null }, { $set: { workId: row._id,
      processId, attempt, phase: 'preparing', claimedAt: new Date() } }, acknowledged);
    if (claim.matchedCount !== 1) return;
    row = await works.repo.mutate(row._id, async current => {
      if (current.state !== 'queued' || !await gate().findOne({ _id: OWNER, workId: row._id, processId, phase: 'preparing' })) return null;
      return { fields: { state: 'dispatching', attempt }, event: 'dispatch_marked' };
    });
    if (row.attempt?.id !== id) { await clear(row._id, processId); return; }
    let prepared;
    try {
      const session = await works.session(row.sessionId);
      const selected = row.contextRef ? await works.repo.read(row, row.contextRef) : { selectedContext: '' };
      prepared = await prepare({ row, session, selectedContext: selected.selectedContext });
    } catch {
      const refused = await gate().updateOne({ _id: OWNER, workId: row._id, processId, phase: 'preparing' },
        { $set: { phase: 'abandoned' } }, acknowledged);
      if (refused.matchedCount === 1) {
        await works.repo.mutate(row._id, current => ({ fields: { state: 'failed', attempt: null, reason: 'native_preparation_refused' }, event: 'preparation_refused' }));
        await clear(row._id, processId);
      }
      return;
    }
    // A restart may revoke an unfinished preparation with an exact CAS. Only
    // this acknowledged dispatch fence permits the single outbound native call.
    const dispatch = await gate().updateOne({ _id: OWNER, workId: row._id, processId, phase: 'preparing' },
      { $set: { phase: 'dispatching' } }, acknowledged);
    if (dispatch.matchedCount !== 1) return;
    try {
      await execute({ ...prepared, row,
        onStarted: async (sessionKey, runId) => {
          if (sessionKey !== row.attempt.sessionKey) throw new Error('Native work session mismatch');
          if (runId) await works.repo.mutate(row._id, saved => ({ fields: { state: saved.result ? 'result_ready' : 'running',
            attempt: { ...saved.attempt, runId } }, event: 'native_started' }));
        } });
    } catch (cause) {
      logger?.warn?.('Conversation work native dispatch unsettled', { workId: row._id, code: cause.code || 'NATIVE_DISPATCH_UNSETTLED' });
    }
    // A returned promise is not the receipt. Observe native settlement and the
    // separately published Core result, including when the HTTP response was lost.
    await reconcile(await works.repo.getIncludingErased(row._id));
  }

  async function recoverPreparation(occupied, row) {
    const claimed = await gate().updateOne({ _id: OWNER, workId: occupied.workId,
      processId: occupied.processId, phase: 'preparing' }, { $set: { phase: 'abandoned' } }, acknowledged);
    if (claimed.matchedCount !== 1 && occupied.phase !== 'abandoned') return;
    if (row && !row.erased) await works.repo.mutate(row._id, async current => {
      if (!await gate().findOne({ _id: OWNER, workId: row._id, processId: occupied.processId, phase: 'abandoned' })) return null;
      if (current.attempt && current.attempt.id !== occupied.attempt?.id) return null;
      return { fields: { state: current.state === 'cancelled' ? 'cancelled' : 'queued', attempt: null }, event: 'preparation_recovered' };
    });
    await clear(occupied.workId, occupied.processId);
  }

  async function tick() {
    if (closed || running || mongoose.connection.readyState !== 1) return;
    running = true;
    try {
      await works.recover();
      const occupied = await gate().findOne({ _id: OWNER });
      if (occupied?.workId) {
        const row = await works.repo.getIncludingErased(occupied.workId);
        if (['preparing', 'abandoned'].includes(occupied.phase)) await recoverPreparation(occupied, row);
        else if (row) await reconcile(row);
        return;
      }
      const [row] = await works.repo.find({ state: 'queued', contextReady: true }, 1);
      if (row) await run(row);
    } catch (cause) { logger?.warn?.('Conversation work observer unavailable', { code: cause.code || 'WORK_OBSERVER_UNAVAILABLE' }); }
    finally { running = false; }
  }
  function start() {
    if (timer || closed) return;
    timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.();
    works.wakeWith(() => { void tick(); });
    void tick();
  }
  function stop() { closed = true; clearInterval(timer); works.wakeWith(() => {}); }
  return { start, stop, tick, reconcile };
}
module.exports = { createWorkObserver };

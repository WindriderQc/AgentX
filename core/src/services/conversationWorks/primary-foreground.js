'use strict';

const { fail, notFound } = require('./contract');
const PRIMARY = 'main-first/v1';
async function occupiedMain(repo, observer, expected) {
  const gate = await repo.dispatchOwner();
  if (!gate?.workId || gate.phase !== 'dispatching' || expected && gate.workId !== expected.workId) return null;
  const owner = await repo.get(gate.workId), attempt = owner?.attempt;
  if (owner?.state !== 'running' || owner.result || attempt?.settledAt || attempt?.agentId !== 'main'
      || attempt.id !== gate.attempt?.id || attempt.sessionKey !== gate.attempt?.sessionKey
      || !/^resp_[a-f0-9-]{36}$/.test(attempt.runId || '')
      || observer?.isExecuting?.(owner._id, attempt.id, attempt.runId, attempt.sessionKey) !== true
      || expected && (attempt.id !== expected.attemptId || attempt.runId !== expected.runId)) return null;
  return owner;
}
const pause = (signal, ms) => new Promise((resolve, reject) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); resolve(); };
  const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
});

// A foreground reader of the existing admitted work, not another executor.
// The observer's native gate remains the only authority to dispatch Main.
function createPrimaryForeground(works, observer, { pollMs = 50 } = {}) {
  async function background(id) {
    return works.repo.mutate(id, current => {
      if (current.entryPolicy !== PRIMARY || current.foreground !== 'primary' || current.result
          || current.primary?.delivery === 'background') return null;
      return { fields: { primary: { ...current.primary, delivery: 'background' } }, event: 'primary_detached' };
    });
  }
  async function relay(id) {
    return works.repo.mutate(id, async current => {
      if (current.attempt || current.state !== 'queued' || current.entryPolicy !== PRIMARY) return null;
      const owner = await occupiedMain(works.repo, observer);
      // Missing/uncertain identities never attest an occupied Main. No model
      // text, client flag or caller header participates in this decision.
      if (!owner || owner._id === id
          || !current.guardian?.sessionId || ['main', 'family'].includes(current.guardian.agentId)) return null;
      const text = await works.requestTextForDisplay(current);
      if (text === null) throw notFound();
      const classification = works.relayClassification(text);
      return { fields: { foreground: 'guardian', classification,
        state: classification === 'native_review' ? 'received' : current.state,
        guardian: { ...current.guardian, state: 'pending' },
        primary: { ...current.primary, delivery: 'background', relayFor: { workId: owner._id,
          attemptId: owner.attempt.id, runId: owner.attempt.runId } } }, event: 'primary_relay_selected' };
    });
  }
  async function reply(id, { signal } = {}) {
    let row = await works.repo.get(id);
    if (row?.entryPolicy !== PRIMARY) return null;
    // This is an explicit accepted turn, not a browser projection/poll. Reuse
    // exactly the existing observer; its gate arbitrates concurrent intakes.
    void observer.tick();
    try {
      while (true) {
        signal?.throwIfAborted();
        row = await works.repo.get(id);
        if (!row) throw notFound();
        await works.session(row.sessionId);
        if (row.foreground === 'guardian') return null;
        if (row.result) {
          await observer.settled?.(id);
          row = await works.repo.get(id);
          if (!row) throw notFound();
          await works.session(row.sessionId);
          const result = await works.repo.read(row, row.result.payloadRef);
          const tool = row.tools.find(item => item.tool === 'native.consultation' && item.runId === row.attempt?.runId);
          if (!tool || result.kind === 'no_work') throw fail('CONVERSATION_WORK_PRIMARY_RESULT_UNAVAILABLE', 'Main has no verified answer for this request.', 503);
          const evidence = await works.repo.read(row, tool.payloadRef);
          return { result, evidence, workId: id, attempt: row.attempt, version: row.result.version, fingerprint: row.result.fingerprint };
        }
        if (['uncertain', 'failed', 'cancelled', 'paused'].includes(row.state)) { await background(id); return { statusOnly: true }; }
        if (!row.attempt) {
          row = await relay(id);
          if (row.foreground === 'guardian') return null;
          const gate = await works.repo.dispatchOwner();
          if (gate?.workId && gate.workId !== id) { await background(id); return { statusOnly: true }; }
        }
        await pause(signal, pollMs);
      }
    } catch (cause) {
      if (signal?.aborted) await background(id).catch(() => {});
      throw cause;
    }
  }
  return { reply, background };
}

module.exports = { createPrimaryForeground, occupiedMain, PRIMARY };

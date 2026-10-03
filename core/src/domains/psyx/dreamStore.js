'use strict';

// Storage for the dream: the portrait, its previous version, and a log of the
// memory changes each dream made so the user can undo them. Every write is
// guarded by the state revision: a dream is computed over minutes, and what the
// user did meanwhile always wins.

const crypto = require('crypto');
const { LIMITS, MEMORY_KINDS, normalizeStoredPortrait, statementKey } = require('./dream');

const ATTEMPTS = 5;
const conflict = () => Object.assign(new Error('PsyX state kept changing during the dream'), { statusCode: 409, code: 'PSYX_DREAM_STATE_CONFLICT' });
const notFound = message => Object.assign(new Error(message), { statusCode: 404 });

function createDreamStore({ collection, read, ensureDocument, createStateItem, limits }) {
  async function guarded(userId, change) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const state = await read(userId);
      const outcome = await change(state);
      if (!outcome?.set) return { ...outcome, state };
      // A document older than the revision counter has none yet.
      const result = await collection.updateOne({ userId, revision: state.revision || { $in: [0, null] } },
        { $set: { ...outcome.set, updatedAt: new Date() }, $inc: { revision: 1 } });
      if (result.modifiedCount) return { ...outcome, set: undefined, state: await read(userId) };
    }
    throw conflict();
  }

  // Applies a dream: the new portrait replaces the current one, additions enter
  // memory as dream-sourced items, retirements mark an item resolved.
  async function recordDream(userId, { dream, kind = 'night', model = null, location = 'local', sources = [], covers = {}, resetAt = null, stillWanted = null }) {
    await ensureDocument(userId);
    return guarded(userId, async state => {
      if ((state.resetAt || null) !== (resetAt || null)) return { skipped: 'reset' };
      if (stillWanted && !await stillWanted()) return { skipped: 'gone' };
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const set = {};
      const lists = Object.fromEntries(MEMORY_KINDS.map(key => [key, state[key]]));
      const added = [], retired = [];
      // What an earlier dream added and is no longer there was removed by him: never add it again.
      const present = new Set(MEMORY_KINDS.flatMap(key => state[key].map(item => item.id)));
      const removed = new Set(state.dreamLog.flatMap(entry => entry.added).filter(item => !present.has(item.id)).map(item => statementKey(item.text)));
      for (const op of dream.memory) {
        if (op.op === 'add') {
          const item = createStateItem(op.kind, { text: op.text, evidence: op.evidence, confidence: op.confidence, status: op.kind === 'hypotheses' ? 'working' : 'active' }, 'dream');
          // A full list is left alone: adding would push out its oldest item, possibly one he wrote.
          if (removed.has(statementKey(item.text)) || lists[op.kind].length >= limits[op.kind] || lists[op.kind].some(entry => entry.fingerprint === item.fingerprint)) continue;
          lists[op.kind] = [...lists[op.kind], item];
          added.push({ kind: op.kind, id: item.id, text: item.text });
        } else {
          const item = lists[op.kind].find(entry => entry.id === op.id);
          // Rechecked against the current state: he may have corrected it while the dream ran.
          if (!item || item.source === 'user' || item.correctedBy === 'user' || ['resolved', 'rejected'].includes(item.status)) continue;
          lists[op.kind] = lists[op.kind].map(entry => entry.id === op.id ? { ...entry, status: 'resolved', updatedAt: now } : entry);
          retired.push({ kind: op.kind, id: item.id, text: item.text, status: item.status, reason: op.reason });
        }
      }
      for (const key of new Set([...added, ...retired].map(item => item.kind))) set[key] = lists[key];
      set.portrait = normalizeStoredPortrait({ id, updatedAt: now, kind, model, location, sections: dream.sections, findings: dream.findings,
        agenda: dream.agenda, questions: dream.questions, intake: dream.intake, sources, covers });
      set.portraitPrevious = state.portrait;
      const entry = { id, at: now, kind, added, retired, findings: dream.findings.length, undone: false };
      set.dreamLog = [...state.dreamLog, entry].slice(-LIMITS.log);
      return { set, entry };
    });
  }

  // Takes back what one dream wrote: its additions leave memory unless he has
  // corrected them since, its retirements come back, and the portrait returns
  // to the previous one when this dream wrote the current one.
  async function undoDream(userId, id) {
    return guarded(userId, async state => {
      const entry = state.dreamLog.find(item => item.id === id);
      if (!entry || entry.undone) throw notFound('PsyX dream not found');
      const set = { dreamLog: state.dreamLog.map(item => item.id === id ? { ...item, undone: true } : item) };
      for (const key of new Set([...entry.added, ...entry.retired].map(item => item.kind))) {
        const addedIds = new Set(entry.added.filter(item => item.kind === key).map(item => item.id));
        const back = new Map(entry.retired.filter(item => item.kind === key).map(item => [item.id, item.status || 'active']));
        set[key] = state[key].filter(item => !(addedIds.has(item.id) && item.source === 'dream' && !item.correctedBy))
          .map(item => back.has(item.id) && item.status === 'resolved' ? { ...item, status: back.get(item.id) } : item);
      }
      // An undone dream's portrait must not come back through a later undo either.
      if (state.portrait?.id === id) { set.portrait = state.portraitPrevious; set.portraitPrevious = null; }
      else if (state.portraitPrevious?.id === id) set.portraitPrevious = null;
      return { set, undone: true };
    });
  }

  // "This is not me": the statement leaves the portrait and later dreams may not restate it.
  async function rejectPortraitStatement(userId, statementId) {
    return guarded(userId, async state => {
      const statement = state.portrait?.sections.flatMap(section => section.statements).find(item => item.id === statementId);
      if (!statement) throw notFound('PsyX portrait statement not found');
      const without = portrait => portrait && { ...portrait, sections: portrait.sections.map(section => ({ ...section, statements: section.statements.filter(item => item.id !== statementId) }))
        .filter(section => section.statements.length) };
      return { set: { portrait: without(state.portrait), portraitPrevious: without(state.portraitPrevious), portraitRejected: [...state.portraitRejected, statement.text].slice(-LIMITS.rejected) }, rejected: true };
    });
  }

  // The portrait is built from every conversation, so a permanent deletion
  // discards it and it is rebuilt from what remains. Memory items a dream added
  // stay, like accepted proposals, until he removes them or undoes that dream.
  async function clearPortrait(userId) {
    const result = await collection.updateOne({ userId, portrait: { $ne: null } },
      { $set: { portrait: null, portraitPrevious: null, updatedAt: new Date() }, $inc: { revision: 1 } });
    return { cleared: result.modifiedCount > 0 };
  }

  async function dreamUserIds() {
    return (await collection.distinct('userId')).filter(Boolean);
  }

  return { recordDream, undoDream, rejectPortraitStatement, clearPortrait, dreamUserIds };
}

module.exports = { createDreamStore };

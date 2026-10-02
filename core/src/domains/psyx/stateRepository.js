'use strict';

const crypto = require('crypto');
const proposals = require('./proposals');
const followUp = require('./followUp');

const PSYX_STATE_VERSION = 2;
const STATE_ITEM_KEYS = ['activeThreads', 'notes', 'patterns', 'hypotheses', 'openLoops'];
const STATE_ITEM_KEY_SET = new Set(STATE_ITEM_KEYS);
const STATE_LIMITS = Object.freeze({
  activeThreads: 50,
  notes: 100,
  patterns: 50,
  hypotheses: 50,
  openLoops: 50,
  experiments: 50
});

function cleanText(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function stableHash(...parts) {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 24);
}

function stableLegacyId(key, text) {
  return `legacy-${stableHash(key, text).slice(0, 20)}`;
}

function stateItemFingerprint(key, text) {
  return stableHash('psyx-state', key, cleanText(text, 1000).toLocaleLowerCase('en-US'));
}

function normalizeDate(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

// A missing confidence stays unknown; Number(null) would read as 0%.
function confidenceValue(value) {
  return value == null || value === '' ? NaN : Number(value);
}

function normalizeStateItem(raw, key) {
  if (typeof raw === 'string') {
    const text = cleanText(raw, key === 'notes' ? 1000 : 500);
    if (!text) return null;
    return {
      id: stableLegacyId(key, text),
      text,
      source: 'legacy',
      confidence: null,
      evidence: [],
      status: 'active',
      fingerprint: stateItemFingerprint(key, text),
      createdAt: null,
      updatedAt: null
    };
  }
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text, key === 'notes' ? 1000 : 500);
  if (!text) return null;
  const confidence = confidenceValue(raw.confidence);
  return {
    id: cleanText(raw.id || crypto.randomUUID(), 80),
    text,
    source: ['user', 'psyx', 'legacy', 'import'].includes(raw.source) ? raw.source : 'user',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 20)
      : [],
    status: ['active', 'working', 'confirmed', 'rejected', 'resolved'].includes(raw.status) ? raw.status : 'active',
    fingerprint: stateItemFingerprint(key, text),
    createdAt: normalizeDate(raw.createdAt),
    updatedAt: normalizeDate(raw.updatedAt)
  };
}

function createStateItem(key, body = {}, source = 'user') {
  if (!STATE_ITEM_KEY_SET.has(key)) throw new Error(`Unknown PsyX state key: ${key}`);
  const text = cleanText(body.text, key === 'notes' ? 1000 : 500);
  if (!text) {
    const error = new Error('text is required');
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const confidence = confidenceValue(body.confidence);
  return {
    id: crypto.randomUUID(),
    text,
    source: ['user', 'psyx', 'import'].includes(source) ? source : 'user',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    evidence: Array.isArray(body.evidence)
      ? body.evidence.map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 20)
      : [],
    status: ['active', 'working', 'confirmed', 'rejected', 'resolved'].includes(body.status) ? body.status : 'active',
    fingerprint: stateItemFingerprint(key, text),
    createdAt: now,
    updatedAt: now
  };
}

function experimentFingerprint(hypothesis, action) {
  return stableHash(
    'psyx-experiment',
    cleanText(hypothesis, 1000).toLocaleLowerCase('en-US'),
    cleanText(action, 1000).toLocaleLowerCase('en-US')
  );
}

function sanitizeExperiments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-STATE_LIMITS.experiments).map((item) => {
    const hypothesis = cleanText(item?.hypothesis, 1000);
    const action = cleanText(item?.action, 1000);
    if (!hypothesis || !action) return null;
    const now = new Date().toISOString();
    return {
      id: cleanText(item?.id || crypto.randomUUID(), 80),
      hypothesis,
      action,
      expectedSignal: cleanText(item?.expectedSignal, 1000),
      result: cleanText(item?.result, 1500),
      status: ['planned', 'active', 'completed', 'abandoned'].includes(item?.status) ? item.status : 'planned',
      outcome: followUp.EXPERIMENT_OUTCOMES.includes(item?.outcome) ? item.outcome : null,
      checkInAt: followUp.dateOrNull(item?.checkInAt),
      fingerprint: experimentFingerprint(hypothesis, action),
      createdAt: normalizeDate(item?.createdAt, now),
      updatedAt: normalizeDate(item?.updatedAt, now)
    };
  }).filter(Boolean);
}

function emptyState(userId = 'default') {
  return {
    userId,
    version: PSYX_STATE_VERSION,
    revision: 0,
    activeThreads: [],
    notes: [],
    patterns: [],
    hypotheses: [],
    openLoops: [],
    experiments: [],
    proposals: [],
    settledProposals: [],
    sessionDigests: [],
    checkIns: [],
    updatedAt: null
  };
}

function normalizeState(doc, userId = 'default') {
  const base = emptyState(userId);
  if (!doc) return base;
  const result = {
    ...base,
    userId: cleanText(doc.userId || userId, 200) || 'default',
    version: PSYX_STATE_VERSION,
    revision: Number.isInteger(doc.revision) && doc.revision >= 0 ? doc.revision : 0,
    experiments: sanitizeExperiments(doc.experiments || []),
    proposals: proposals.normalizeProposals(doc.proposals),
    settledProposals: proposals.normalizeSettled(doc.settledProposals),
    sessionDigests: proposals.normalizeDigests(doc.sessionDigests),
    checkIns: followUp.normalizeCheckIns(doc.checkIns),
    resetAt: normalizeDate(doc.resetAt),
    updatedAt: normalizeDate(doc.updatedAt)
  };
  for (const key of STATE_ITEM_KEYS) {
    result[key] = Array.isArray(doc[key])
      ? doc[key]
        .map((item) => normalizeStateItem(item, key))
        .filter(Boolean)
        .slice(-STATE_LIMITS[key])
      : [];
  }
  return result;
}

function stateForPrompt(state, { conversationId = null } = {}) {
  const compact = {};
  for (const key of STATE_ITEM_KEYS) {
    compact[key] = (state[key] || []).slice(-30).map((item) => ({
      text: item.text,
      source: item.source,
      confidence: item.confidence,
      evidence: item.evidence,
      status: item.status
    }));
  }
  compact.experiments = (state.experiments || [])
    .filter((item) => item.status === 'planned' || item.status === 'active')
    .slice(-10)
    .map(({ id, hypothesis, action, expectedSignal, result, status, checkInAt }) => ({ id, hypothesis, action, expectedSignal, result, status, checkInAt, due: followUp.isDue({ status, checkInAt }) }));
  compact.recentCheckIns = (state.checkIns || []).slice(-5).map(({ score, phase, at }) => ({ score, phase, at }));
  // Digests of other recent conversations give continuity across sessions.
  compact.recentSessions = (state.sessionDigests || [])
    .filter((item) => item.conversationId !== conversationId)
    .slice(-3)
    .map(({ summary, movement, commitment, updatedAt }) => ({ summary, movement, commitment, updatedAt }));
  return compact;
}

function deduplicateBy(values, keyOf, limit) {
  const seen = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!key) continue;
    if (seen.has(key)) seen.delete(key);
    seen.set(key, value);
  }
  return [...seen.values()].slice(-limit);
}

function mergeStateDocuments(documents, userId = 'default') {
  const normalized = documents.map((doc) => normalizeState(doc, userId));
  const merged = emptyState(userId);
  merged.revision = normalized.reduce((max, state) => Math.max(max, state.revision), 0);
  const updateTimes = normalized.map((state) => state.updatedAt).filter(Boolean).sort();
  merged.updatedAt = updateTimes.at(-1) || null;
  for (const key of STATE_ITEM_KEYS) {
    merged[key] = deduplicateBy(
      normalized.flatMap((state) => state[key]),
      (item) => item.fingerprint,
      STATE_LIMITS[key]
    );
  }
  merged.experiments = deduplicateBy(
    normalized.flatMap((state) => state.experiments),
    (item) => item.fingerprint,
    STATE_LIMITS.experiments
  );
  return merged;
}

function createExperiment(body = {}) {
  const hypothesis = cleanText(body.hypothesis, 1000);
  const action = cleanText(body.action, 1000);
  if (!hypothesis || !action) {
    const error = new Error('hypothesis and action are required');
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    hypothesis,
    action,
    expectedSignal: cleanText(body.expectedSignal, 1000),
    result: '',
    status: 'planned',
    outcome: null,
    checkInAt: followUp.checkInAtFrom(body.checkInDays),
    fingerprint: experimentFingerprint(hypothesis, action),
    createdAt: now,
    updatedAt: now
  };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => cleanText(source?.[key])).map((key) => [key, source[key]]));
}

function unknownSectionError() {
  const error = new Error('Unknown PsyX state section');
  error.statusCode = 404;
  return error;
}

function createStateRepository({ collection, logger }) {
  if (!collection) throw new Error('PsyX state storage collection is required');

  async function ensureInfrastructure() {
    try {
      const docs = await collection.find({}).sort({ updatedAt: -1, _id: 1 }).toArray();
      const groups = new Map();
      for (const doc of docs) {
        const userId = cleanText(doc.userId || 'default', 200) || 'default';
        if (!groups.has(userId)) groups.set(userId, []);
        groups.get(userId).push(doc);
      }

      for (const [userId, group] of groups) {
        const canonical = group[0];
        const merged = mergeStateDocuments(group.slice().reverse(), userId);
        const update = {
          userId,
          version: PSYX_STATE_VERSION,
          revision: merged.revision,
          updatedAt: merged.updatedAt ? new Date(merged.updatedAt) : new Date()
        };
        for (const key of STATE_ITEM_KEYS) update[key] = merged[key];
        update.experiments = merged.experiments;
        await collection.updateOne({ _id: canonical._id }, { $set: update });
        for (const duplicate of group.slice(1)) {
          await collection.deleteOne({ _id: duplicate._id });
          logger?.warn?.('PsyX merged duplicate longitudinal state document', { userId });
        }
      }

      await collection.createIndex({ userId: 1 }, { unique: true, name: 'psyx_state_user_unique' });
      return { ready: true };
    } catch (error) {
      logger?.error?.('PsyX state infrastructure hardening failed', { error: error.message });
      throw error;
    }
  }

  async function ensureDocument(userId) {
    const now = new Date();
    try {
      await collection.updateOne(
        { userId },
        {
          $setOnInsert: {
            userId,
            version: PSYX_STATE_VERSION,
            revision: 0,
            activeThreads: [],
            notes: [],
            patterns: [],
            hypotheses: [],
            openLoops: [],
            experiments: [],
            proposals: [],
            settledProposals: [],
            sessionDigests: [],
            checkIns: [],
            createdAt: now,
            updatedAt: now
          }
        },
        { upsert: true }
      );
    } catch (error) {
      // Two first mutations may race to create the same unique user document.
      // The winning upsert is sufficient; all later item updates remain atomic.
      if (error?.code !== 11000) throw error;
    }
  }

  async function read(userId) {
    return normalizeState(await collection.findOne({ userId }), userId);
  }

  async function addItem(userId, key, body = {}) {
    if (!STATE_ITEM_KEY_SET.has(key)) throw unknownSectionError();
    await ensureDocument(userId);
    const item = createStateItem(key, body, 'user');
    const result = await collection.updateOne(
      { userId, [`${key}.fingerprint`]: { $ne: item.fingerprint } },
      {
        $push: { [key]: { $each: [item], $slice: -STATE_LIMITS[key] } },
        $inc: { revision: 1 },
        $set: { version: PSYX_STATE_VERSION, updatedAt: new Date() }
      }
    );
    const state = await read(userId);
    if (!result.modifiedCount) {
      return {
        duplicate: true,
        item: state[key].find((entry) => entry.fingerprint === item.fingerprint) || null,
        state
      };
    }
    return { duplicate: false, item, state };
  }

  async function deleteItem(userId, key, id) {
    if (!STATE_ITEM_KEY_SET.has(key)) throw unknownSectionError();
    const result = await collection.updateOne(
      { userId, [`${key}.id`]: id },
      { $pull: { [key]: { id } }, $inc: { revision: 1 }, $set: { updatedAt: new Date() } }
    );
    return { removed: result.modifiedCount > 0, state: await read(userId) };
  }

  async function addExperiment(userId, body = {}) {
    await ensureDocument(userId);
    const item = createExperiment(body);
    const result = await collection.updateOne(
      { userId, 'experiments.fingerprint': { $ne: item.fingerprint } },
      {
        $push: { experiments: { $each: [item], $slice: -STATE_LIMITS.experiments } },
        $inc: { revision: 1 },
        $set: { updatedAt: new Date(), version: PSYX_STATE_VERSION }
      }
    );
    const state = await read(userId);
    if (!result.modifiedCount) {
      return {
        duplicate: true,
        item: state.experiments.find((entry) => entry.fingerprint === item.fingerprint) || null,
        state
      };
    }
    return { duplicate: false, item, state };
  }

  async function updateExperiment(userId, id, body = {}) {
    const set = {};
    const semanticChanges = [];
    if ('status' in body) {
      if (!['planned', 'active', 'completed', 'abandoned'].includes(body.status)) {
        const error = new Error('Invalid experiment status');
        error.statusCode = 400;
        throw error;
      }
      set['experiments.$[experiment].status'] = body.status;
      semanticChanges.push({ experiments: { $elemMatch: { id, status: { $ne: body.status } } } });
    }
    if ('result' in body) {
      const result = cleanText(body.result, 1500);
      set['experiments.$[experiment].result'] = result;
      semanticChanges.push({ experiments: { $elemMatch: { id, result: { $ne: result } } } });
    }
    if ('expectedSignal' in body) {
      const expectedSignal = cleanText(body.expectedSignal, 1000);
      set['experiments.$[experiment].expectedSignal'] = expectedSignal;
      semanticChanges.push({ experiments: { $elemMatch: { id, expectedSignal: { $ne: expectedSignal } } } });
    }
    if ('outcome' in body) {
      const changes = followUp.outcomeChanges(body.outcome);
      for (const [field, value] of Object.entries(changes)) set[`experiments.$[experiment].${field}`] = value;
      semanticChanges.push({ experiments: { $elemMatch: { id, outcome: { $ne: changes.outcome } } } });
      if (changes.checkInAt) semanticChanges.push({ experiments: { $elemMatch: { id, checkInAt: { $ne: changes.checkInAt } } } });
    }
    if ('checkInDays' in body) {
      const checkInAt = followUp.checkInAtFrom(body.checkInDays);
      set['experiments.$[experiment].checkInAt'] = checkInAt;
      semanticChanges.push({ experiments: { $elemMatch: { id, checkInAt: { $ne: checkInAt } } } });
    }
    if (Object.keys(set).length === 0) {
      const error = new Error('No supported experiment changes supplied');
      error.statusCode = 400;
      throw error;
    }
    set['experiments.$[experiment].updatedAt'] = new Date().toISOString();
    set.updatedAt = new Date();
    const result = await collection.updateOne(
      { userId, 'experiments.id': id, $or: semanticChanges },
      { $set: set, $inc: { revision: 1 } },
      { arrayFilters: [{ 'experiment.id': id }] }
    );
    return { updated: result.modifiedCount > 0, state: await read(userId) };
  }

  async function reset(userId) {
    await ensureDocument(userId);
    const now = new Date();
    const cleared = Object.fromEntries([...STATE_ITEM_KEYS, 'experiments', 'proposals', 'settledProposals', 'sessionDigests', 'checkIns'].map((key) => [key, []]));
    await collection.updateOne(
      { userId },
      {
        // resetAt lets a review that started before the reset discard its result.
        $set: { ...cleared, version: PSYX_STATE_VERSION, updatedAt: now, resetAt: now },
        $inc: { revision: 1 }
      }
    );
    return read(userId);
  }

  // Background review output: a digest replaces the conversation's previous one;
  // proposals already known (memory, pending or settled by the user) are dropped.
  async function recordReview(userId, { conversationId, digest = null, proposals: incoming = [], resetAt = null, stillWanted = null }) {
    await ensureDocument(userId);
    const state = await read(userId);
    if ((state.resetAt || null) !== (resetAt || null)) return { added: 0, digest: null, skipped: 'reset', state };
    const known = new Set([
      ...state.proposals.map((item) => item.fingerprint),
      ...state.settledProposals,
      ...STATE_ITEM_KEYS.flatMap((key) => state[key].map((item) => proposals.proposalFingerprint(key, item.text))),
      ...state.experiments.map((item) => proposals.proposalFingerprint('experiments', item.hypothesis, item.action))
    ]);
    const fresh = incoming.filter((item) => !known.has(item.fingerprint));
    // A conversation deleted after the review started must not regain a digest.
    if (stillWanted && !await stillWanted()) return { added: 0, digest: null, skipped: 'gone', state };
    const push = {};
    if (fresh.length) push.proposals = { $each: fresh, $slice: -proposals.PROPOSAL_LIMITS.pending };
    if (digest) push.sessionDigests = { $each: [digest], $slice: -proposals.PROPOSAL_LIMITS.digests };
    if (Object.keys(push).length) {
      await collection.updateOne({ userId }, { $push: push, $inc: { revision: 1 }, $set: { updatedAt: new Date(), version: PSYX_STATE_VERSION } });
    }
    // Then drop the conversation's older digests; readers already prefer the latest.
    if (digest) await collection.updateOne({ userId }, { $pull: { sessionDigests: { conversationId, id: { $ne: digest.id } } } });
    return { added: fresh.length, digest, state: await read(userId) };
  }

  // A permanently deleted conversation leaves nothing derived from it in PsyX memory.
  async function forgetConversation(userId, conversationId) {
    const result = await collection.updateOne({ userId }, {
      $pull: { sessionDigests: { conversationId }, proposals: { conversationId } },
      $inc: { revision: 1 },
      $set: { updatedAt: new Date() }
    });
    return { removed: result.modifiedCount > 0 };
  }

  function proposalNotFound() {
    const error = new Error('PsyX proposal not found');
    error.statusCode = 404;
    return error;
  }

  // Accepting moves a proposal into memory as a PsyX-sourced item; the user may edit its text first.
  async function acceptProposal(userId, id, edits = {}) {
    const state = await read(userId);
    const proposal = state.proposals.find((item) => item.id === id);
    if (!proposal) throw proposalNotFound();
    // The original fingerprint is settled too, so an edited acceptance is not proposed again.
    const update = {
      $pull: { proposals: { id } },
      $push: { settledProposals: { $each: [proposal.fingerprint], $slice: -proposals.PROPOSAL_LIMITS.settled } },
      $inc: { revision: 1 },
      $set: { updatedAt: new Date() }
    };
    let item;
    let options;
    if (proposal.kind === 'experimentResult') {
      // Applies to the experiment it names; if that experiment is gone the proposal is only settled.
      const changes = followUp.outcomeChanges(proposal.outcome);
      const result = cleanText(edits.result, 1500) || proposal.result;
      if (state.experiments.some((entry) => entry.id === proposal.experimentId)) {
        update.$set = { ...update.$set, 'experiments.$[experiment].updatedAt': new Date().toISOString() };
        for (const [field, value] of Object.entries({ ...changes, ...(result ? { result } : {}) })) update.$set[`experiments.$[experiment].${field}`] = value;
        options = { arrayFilters: [{ 'experiment.id': proposal.experimentId }] };
      }
      item = { experimentId: proposal.experimentId, ...changes, result };
    } else if (proposal.kind === 'experiments') {
      item = createExperiment({ ...proposal, ...pick(edits, ['hypothesis', 'action', 'expectedSignal']) });
      if (!state.experiments.some((entry) => entry.fingerprint === item.fingerprint)) {
        update.$push.experiments = { $each: [item], $slice: -STATE_LIMITS.experiments };
      }
    } else {
      item = createStateItem(proposal.kind, {
        text: cleanText(edits.text) || proposal.text,
        evidence: proposal.evidence,
        confidence: proposal.confidence,
        status: proposal.kind === 'hypotheses' ? 'working' : 'active'
      }, 'psyx');
      if (!state[proposal.kind].some((entry) => entry.fingerprint === item.fingerprint)) {
        update.$push[proposal.kind] = { $each: [item], $slice: -STATE_LIMITS[proposal.kind] };
      }
    }
    const result = await collection.updateOne({ userId, 'proposals.id': id }, update, options);
    if (!result.modifiedCount) throw proposalNotFound();
    return { kind: proposal.kind, item, state: await read(userId) };
  }

  // A rejected proposal is settled by fingerprint so the review does not propose it again.
  async function rejectProposal(userId, id) {
    const state = await read(userId);
    const proposal = state.proposals.find((item) => item.id === id);
    if (!proposal) throw proposalNotFound();
    const result = await collection.updateOne({ userId, 'proposals.id': id }, {
      $pull: { proposals: { id } },
      $push: { settledProposals: { $each: [proposal.fingerprint], $slice: -proposals.PROPOSAL_LIMITS.settled } },
      $inc: { revision: 1 },
      $set: { updatedAt: new Date() }
    });
    if (!result.modifiedCount) throw proposalNotFound();
    return { state: await read(userId) };
  }

  // A short self-rating of how heavy things feel, 0 (light) to 10 (heaviest).
  async function addCheckIn(userId, body = {}) {
    const checkIn = followUp.normalizeCheckIn({
      id: crypto.randomUUID(), score: Number(body.score), phase: body.phase,
      conversationId: body.conversationId, at: new Date().toISOString()
    });
    if (!checkIn) {
      const error = new Error('score must be an integer from 0 to 10');
      error.statusCode = 400;
      throw error;
    }
    await ensureDocument(userId);
    await collection.updateOne({ userId }, {
      $push: { checkIns: { $each: [checkIn], $slice: -followUp.CHECK_IN_LIMIT } },
      $inc: { revision: 1 },
      $set: { updatedAt: new Date() }
    });
    return { checkIn, state: await read(userId) };
  }

  return {
    addCheckIn,
    ensureInfrastructure,
    read,
    addItem,
    deleteItem,
    addExperiment,
    updateExperiment,
    reset,
    recordReview,
    forgetConversation,
    acceptProposal,
    rejectProposal
  };
}

module.exports = {
  PSYX_STATE_VERSION,
  STATE_ITEM_KEYS,
  STATE_LIMITS,
  cleanText,
  normalizeStateItem,
  createStateItem,
  sanitizeExperiments,
  emptyState,
  normalizeState,
  stateForPrompt,
  mergeStateDocuments,
  createStateRepository
};

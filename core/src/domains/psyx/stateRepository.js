'use strict';

const crypto = require('crypto');
const proposals = require('./proposals');
const followUp = require('./followUp');

const FRONTIER_MODES = ['local', 'deep', 'all'];
const { createItemCorrection } = require('./stateItemCorrection');
const dream = require('./dream');
const assessments = require('./assessments');
const { createDreamStore } = require('./dreamStore');
const { normalizeEvidenceRefs } = require('./dreamEvidence');

const PSYX_STATE_VERSION = 2;
const STATE_ITEM_KEYS = ['activeThreads', 'notes', 'patterns', 'hypotheses', 'openLoops', 'goals'];
// What the user wrote about himself; like settings, a memory reset keeps it.
const PROFILE_LIMITS = Object.freeze({ about: 3000, expectations: 1500 });
const STATE_ITEM_KEY_SET = new Set(STATE_ITEM_KEYS);
const STATE_LIMITS = Object.freeze({
  activeThreads: 50,
  notes: 100,
  patterns: 50,
  hypotheses: 50,
  openLoops: 50,
  goals: 20,
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
    source: ['user', 'psyx', 'dream', 'legacy', 'import'].includes(raw.source) ? raw.source : 'user',
    sourceConversationId: cleanText(raw.sourceConversationId, 80) || null,
    evidenceRefs: normalizeEvidenceRefs(raw.evidenceRefs),
    correctedBy: raw.correctedBy === 'user' ? 'user' : null,
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
    source: ['user', 'psyx', 'dream', 'import'].includes(source) ? source : 'user',
    sourceConversationId: source === 'psyx' ? cleanText(body.sourceConversationId, 80) || null : null,
    evidenceRefs: source === 'dream' ? normalizeEvidenceRefs(body.evidenceRefs) : [],
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
      checkInAt: followUp.dateOrNull(item?.checkInAt)
        || (['planned', 'active'].includes(item?.status) && normalizeDate(item?.createdAt)
          ? followUp.checkInAtFrom(followUp.DEFAULT_CHECK_IN_DAYS, new Date(item.createdAt).getTime()) : null),
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
    settings: { frontierMode: null },
    profile: { about: '', expectations: '' },
    portrait: null, portraitPrevious: null, portraitRejected: [], dreamLog: [], assessments: [],
    goals: [],
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
    assessments: assessments.normalizeAssessments(doc.assessments),
    portrait: dream.normalizeStoredPortrait(doc.portrait), portraitPrevious: dream.normalizeStoredPortrait(doc.portraitPrevious),
    portraitRejected: dream.normalizeRejected(doc.portraitRejected), dreamLog: dream.normalizeDreamLog(doc.dreamLog),
    profile: { about: cleanText(doc.profile?.about, PROFILE_LIMITS.about), expectations: cleanText(doc.profile?.expectations, PROFILE_LIMITS.expectations) },
    // Preferences, not memory: a reset keeps them.
    settings: { frontierMode: FRONTIER_MODES.includes(doc.settings?.frontierMode) ? doc.settings.frontierMode : null },
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

// A frontier model reads far more context than the local 16k-character message contract allows.
function stateForPrompt(state, { conversationId = null, budget = 'local' } = {}) {
  const wide = budget === 'frontier';
  const compact = {};
  for (const key of STATE_ITEM_KEYS) {
    compact[key] = (state[key] || []).slice(wide ? -60 : -30).map((item) => ({
      text: item.text,
      source: item.source,
      correctedBy: item.correctedBy || null,
      confidence: item.confidence,
      // A local reply has little room: one short quote is enough to anchor an item.
      evidence: wide ? item.evidence : (item.evidence || []).slice(0, 1).map((quote) => cleanText(quote, 120)),
      status: item.status
    }));
  }
  compact.experiments = (state.experiments || [])
    .filter((item) => item.status === 'planned' || item.status === 'active')
    .slice(-10)
    .map(({ id, hypothesis, action, expectedSignal, result, status, checkInAt }) => ({ id, ...Object.fromEntries(Object.entries({ hypothesis, action, expectedSignal, result })
      .map(([field, value]) => [field, wide ? value : cleanText(value, 300)])), status, checkInAt, due: followUp.isDue({ status, checkInAt }) }));
  compact.recentCheckIns = (state.checkIns || []).slice(-5).map(({ score, phase, at }) => ({ score, phase, at }));
  // Digests of other recent conversations give continuity across sessions.
  compact.recentSessions = (state.sessionDigests || [])
    .filter((item) => item.conversationId !== conversationId)
    .slice(wide ? -10 : -3)
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
      if ('status' in body) {
        const error = new Error('Send either an outcome or a status, not both');
        error.statusCode = 400;
        throw error;
      }
      const changes = followUp.outcomeChanges(body.outcome);
      // Recording the same outcome again on a reopened experiment is still a change.
      if (changes.status) semanticChanges.push({ experiments: { $elemMatch: { id, status: { $ne: changes.status } } } });
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
    const cleared = Object.fromEntries([...STATE_ITEM_KEYS, 'experiments', 'proposals', 'settledProposals', 'sessionDigests', 'checkIns', 'assessments'].map((key) => [key, []]));
    await collection.updateOne(
      { userId },
      {
        // resetAt lets a review that started before the reset discard its result.
        $set: { ...cleared, portrait: null, portraitPrevious: null, portraitRejected: [], dreamLog: [], version: PSYX_STATE_VERSION, updatedAt: now, resetAt: now },
        $inc: { revision: 1 }
      }
    );
    return read(userId);
  }

  // Background review output: a digest replaces the conversation's previous one;
  // proposals already known (memory, pending or settled by the user) are dropped.
  async function recordReview(userId, { conversationId, digest = null, proposals: incoming = [], resetAt = null, stillWanted = null }) {
    await ensureDocument(userId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await read(userId);
      if ((state.resetAt || null) !== (resetAt || null)) return { added: 0, digest: null, skipped: 'reset', state };
      const known = new Set([
        ...state.proposals.map((item) => item.fingerprint), ...state.settledProposals,
        ...STATE_ITEM_KEYS.flatMap((key) => state[key].map((item) => proposals.proposalFingerprint(key, item.text))),
        ...state.experiments.map((item) => proposals.proposalFingerprint('experiments', item.hypothesis, item.action))
      ]);
      const fresh = incoming.filter((item) => !known.has(item.fingerprint));
      if (stillWanted && !await stillWanted()) return { added: 0, digest: null, skipped: 'gone', state };
      if (!fresh.length && !digest) return { added: 0, digest: null, state };
      const set = { updatedAt: new Date(), version: PSYX_STATE_VERSION };
      if (fresh.length) set.proposals = [...state.proposals, ...fresh].slice(-proposals.PROPOSAL_LIMITS.pending);
      if (digest) set.sessionDigests = [...state.sessionDigests.filter(item => item.conversationId !== conversationId), digest].slice(-proposals.PROPOSAL_LIMITS.digests);
      // Reset, erasure and proposal decisions change the revision. Replace both
      // derived arrays together, or reread; stale model output cannot undo them.
      const result = await collection.updateOne({ userId, revision: state.revision }, { $set: set, $inc: { revision: 1 } });
      if (result.modifiedCount) return { added: fresh.length, digest, state: await read(userId) };
    }
    throw Object.assign(new Error('PsyX state changed during review'), { statusCode: 409, code: 'PSYX_REVIEW_STATE_CONFLICT' });
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
      // Only an experiment still open takes the outcome; one the user closed meanwhile keeps the user's decision.
      if (state.experiments.some((entry) => entry.id === proposal.experimentId && ['planned', 'active'].includes(entry.status))) {
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
        sourceConversationId: proposal.conversationId,
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
    const checkIn = followUp.normalizeCheckIn({ id: crypto.randomUUID(), score: body.score, phase: body.phase, at: new Date().toISOString() });
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

  // A completed questionnaire, scored here from the answers.
  async function addAssessment(userId, body = {}) {
    const assessment = assessments.createAssessment(body.kind, body.answers);
    await ensureDocument(userId);
    await collection.updateOne({ userId }, { $push: { assessments: { $each: [assessment], $slice: -assessments.ASSESSMENT_LIMIT } }, $inc: { revision: 1 }, $set: { updatedAt: new Date() } });
    return { assessment, state: await read(userId) };
  }

  async function updateSettings(userId, body = {}) {
    if (!FRONTIER_MODES.includes(body.frontierMode)) {
      const error = new Error('frontierMode must be local, deep or all');
      error.statusCode = 400;
      throw error;
    }
    await ensureDocument(userId);
    const current = (await collection.findOne({ userId }))?.settings || {};
    await collection.updateOne({ userId }, { $set: { settings: { ...current, frontierMode: body.frontierMode }, updatedAt: new Date() }, $inc: { revision: 1 } });
    return { state: await read(userId) };
  }

  async function updateProfile(userId, body = {}) {
    if ([body.about, body.expectations].some((value) => value != null && typeof value !== 'string')) throw Object.assign(new Error('about and expectations must be text'), { statusCode: 400 });
    await ensureDocument(userId);
    const profile = { about: cleanText(body.about, PROFILE_LIMITS.about), expectations: cleanText(body.expectations, PROFILE_LIMITS.expectations) };
    await collection.updateOne({ userId }, { $set: { profile, updatedAt: new Date() }, $inc: { revision: 1 } });
    return { state: await read(userId) };
  }

  return {
    ...createDreamStore({ collection, read, ensureDocument, createStateItem, limits: STATE_LIMITS }),
    updateProfile,
    addAssessment,
    updateSettings,
    updateItem: createItemCorrection({ collection, read, keys: STATE_ITEM_KEYS, cleanText, fingerprint: stateItemFingerprint }),
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

'use strict';

const crypto = require('crypto');

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
  const confidence = Number(raw.confidence);
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
  const confidence = Number(body.confidence);
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

function stateForPrompt(state) {
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
    .map(({ id, hypothesis, action, expectedSignal, result, status }) => ({ id, hypothesis, action, expectedSignal, result, status }));
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
    const hypothesis = cleanText(body.hypothesis, 1000);
    const action = cleanText(body.action, 1000);
    if (!hypothesis || !action) {
      const error = new Error('hypothesis and action are required');
      error.statusCode = 400;
      throw error;
    }
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      hypothesis,
      action,
      expectedSignal: cleanText(body.expectedSignal, 1000),
      result: '',
      status: 'planned',
      fingerprint: experimentFingerprint(hypothesis, action),
      createdAt: now,
      updatedAt: now
    };
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
    const cleared = Object.fromEntries([...STATE_ITEM_KEYS, 'experiments'].map((key) => [key, []]));
    await collection.updateOne(
      { userId },
      {
        $set: { ...cleared, version: PSYX_STATE_VERSION, updatedAt: now },
        $inc: { revision: 1 }
      }
    );
    return read(userId);
  }

  return {
    ensureInfrastructure,
    read,
    addItem,
    deleteItem,
    addExperiment,
    updateExperiment,
    reset
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

'use strict';

const store = require('./transcriptStore');
const internal = Symbol('conversationTranscriptInternal');
const hasMessages = value => /"\$?messages(?:[".])/.test(JSON.stringify(value || {}));
const messageField = key => key === 'messages' || key.startsWith('messages.');
const versionFilter = row => row.__v == null ? { __v: { $exists: false } } : { __v: row.__v };

// A candidate filter is an over-approximation, never the final write predicate.
function rootFilter(filter) {
  const result = {};
  for (const [key, value] of Object.entries(filter)) {
    if (['$or', '$and'].includes(key)) result[key] = value.map(rootFilter);
    else if (key === '$nor') {
      if (!hasMessages(value)) result[key] = value;
    } else if (!messageField(key)) result[key] = value;
  }
  return result;
}

function queryFields(value, prefix = '', role = null) {
  const fields = [];
  for (const [key, condition] of Object.entries(value || {})) {
    if (['$or', '$and', '$nor'].includes(key)) fields.push(...condition.flatMap(branch => queryFields(branch, prefix, role)));
    else if (!key.startsWith('$')) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (condition?.$elemMatch) fields.push(...queryFields(condition.$elemMatch, path,
        typeof condition.$elemMatch.role === 'string' ? condition.$elemMatch.role : role));
      else fields.push({ path, role, existenceOnly: condition && typeof condition === 'object'
        && Object.keys(condition).length === 1 && Object.hasOwn(condition, '$exists') });
    }
  }
  return fields;
}

async function verifyRoots(model, filter = {}, conditions = [filter]) {
  const cursor = model.collection.find({ $and: [rootFilter(filter), { transcript: { $exists: true } }] },
    { projection: { _id: 1, transcript: 1 } });
  const fields = conditions.flatMap(condition => queryFields(condition));
  for await (const row of cursor) {
    const items = await store.readPageItems(row._id, row.transcript);
    if (items.some(message => (message._projectedFields || []).some(path => fields.some(field =>
      (!field.role || field.role === message.role) && (field.path === path || field.path.startsWith(`${path}.`)
        || !field.existenceOnly && path.startsWith(`${field.path}.`)))))) {
      throw Object.assign(new Error('This condition requires full content outside the query projection.'),
        { code: 'CONVERSATION_QUERY_REQUIRES_FULL_CONTENT', statusCode: 503 });
    }
  }
}

async function matchingRoots(model, filter, options = {}) {
  if (!hasMessages(filter)) return model.collection.find(filter, options).toArray();
  await verifyRoots(model, filter);
  return model.collection.aggregate([{ $match: rootFilter(filter) }, ...store.transcriptStages(),
    { $match: filter }, { $project: { messages: 0 } }], { allowDiskUse: true }).toArray();
}

// Preserve every root condition, including logical branches. Evaluate only
// message predicates against the current immutable reference, then keep that
// exact root version in the final Mongo command. A raw scope change therefore
// cannot turn the publication into an identity-only update.
async function exactRootFilter(model, row, filter) {
  const clauses = [];
  for (const [key, value] of Object.entries(filter)) {
    if (['$or', '$and', '$nor'].includes(key)) {
      clauses.push({ [key]: await Promise.all(value.map(branch => exactRootConditions(model, row, branch))) });
    } else if (messageField(key)) {
      const matched = await model.collection.aggregate([{ $match: { _id: row._id } },
        ...store.transcriptStages(), { $match: { [key]: value } }, { $limit: 1 },
        { $project: { _id: 1 } }], { allowDiskUse: true }).toArray();
      clauses.push({ $expr: { $literal: matched.length === 1 } });
    } else clauses.push({ [key]: value });
  }
  return { $and: [...clauses, { _id: row._id }, versionFilter(row)] };
}

async function exactRootConditions(model, row, filter) {
  // The identity/version guards can be repeated inside logical branches: each
  // refers to this same snapshot and never broadens a caller's condition.
  return exactRootFilter(model, row, filter);
}

function projectMessage(value, fields, inclusive, prefix = '') {
  if (Array.isArray(value)) return value.map(entry => projectMessage(entry, fields, inclusive, prefix));
  if (!value || typeof value !== 'object' || value._bsontype || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Object.hasOwn(fields, path)) return fields[path] ? [[key, entry]] : [];
    if (Object.keys(fields).some(field => field.startsWith(`${path}.`))) {
      return [[key, projectMessage(entry, fields, inclusive, path)]];
    }
    return inclusive ? [] : [[key, entry]];
  }));
}

async function hydrate(row, projection) {
  if (!row?.transcript || row.messages === undefined) return;
  let messages = await store.readTranscript(row._id, row.transcript);
  if (projection) messages = messages.map(message => projectMessage(message, projection,
    Object.values(projection).some(value => value === 1)));
  if (typeof row.set === 'function') {
    row.$locals.transcriptLoadedOwner = row.userId;
    row.set('messages', messages);
    for (const child of row.$getAllSubdocs()) {
      child.$isNew = false;
      for (const path of child.modifiedPaths()) child.unmarkModified(path);
    }
    row.unmarkModified('messages');
  } else row.messages = messages;
}

async function prepareRead() {
  if (this[internal]) return;
  this.cast(this.model);
  const filter = this.getFilter();
  if (hasMessages(filter)) {
    const roots = await matchingRoots(this.model, filter);
    this.setQuery({ $or: roots.length ? await Promise.all(roots.map(row => exactRootFilter(this.model, row, filter)))
      : [{ _id: { $in: [] } }] });
  }
  configureProjection.call(this);
}

function configureProjection() {
  // Mongoose keeps signed select strings until this normalization step.
  this._applyPaths();
  const projection = this.projection();
  const messageKeys = Object.keys(projection || {}).filter(messageField);
  const inclusive = projection && Object.values(projection).some(value => value === 1);
  const include = !projection || !inclusive && projection.messages !== 0
    || messageKeys.some(key => projection[key] !== 0);
  this._hydrateTranscript = include;
  if (include && messageKeys.some(key => key !== 'messages')) {
    this._transcriptMessageProjection = Object.fromEntries(messageKeys.filter(key => key !== 'messages')
      .map(key => [key.slice('messages.'.length), projection[key]]));
    for (const key of messageKeys) delete projection[key];
    if (inclusive) projection.messages = 1;
  }
  if (include) this.select('+transcript');
  if (inclusive && include) this.select({ transcript: 1, __v: 1 });
  if (projection?.messages?.$slice != null) {
    this._transcriptSlice = projection.messages.$slice;
    if (inclusive) projection.messages = 1;
    else delete projection.messages;
  }
}

async function finishRead(result) {
  if (this._hydrateTranscript === false) return;
  for (const row of Array.isArray(result) ? result : [result]) {
    await hydrate(row, this._transcriptMessageProjection);
    if (row?.$locals && this._transcriptMessageProjection) row.$locals.transcriptPartial = true;
    const slice = this._transcriptSlice;
    if (slice != null && row?.messages) {
      row.messages = Array.isArray(slice) ? row.messages.slice(slice[0], slice[0] + slice[1])
        : slice < 0 ? row.messages.slice(slice) : row.messages.slice(0, slice);
      if (row.$locals) row.$locals.transcriptPartial = true;
    }
  }
}

module.exports = { internal, hasMessages, messageField, rootFilter, versionFilter, verifyRoots,
  matchingRoots, exactRootFilter, hydrate, prepareRead, configureProjection, finishRead };

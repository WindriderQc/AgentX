'use strict';

// Links between the owner's private sources for one recall answer. Only an
// identical message or thread identifier, or a souvenir's own moment, links two
// records: no similarity, no inference and no new store. Each link names its
// source system and record id, and nothing here creates, accepts or changes a
// task, moment, note or digest. Forgotten, replaced, expired and closed
// records stay out; missing dates stay null.

const PER_RESULT = 6;
const PER_STORE = 50;
const OPEN_TASK = ['queued', 'in_progress', 'review', 'blocked'];
// Provider ids vary (Gmail hex, RFC Message-ID, export paths): compared verbatim.
const ID = /^[^\u0000-\u001f]{1,256}$/;
const NOTE_ID = /^[a-f0-9]{24}$/;

const short = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const isoDate = value => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const exactIds = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim() && ID.test(value)))];

function defaultStores() {
  return {
    MailJournalEntry: require('../../models/MailJournalEntry'),
    PersonalHistoryEntry: require('../../models/PersonalHistoryEntry'),
    MemoryNote: require('../../models/MemoryNote'),
    PersonalTaskDossier: require('../../models/PersonalTaskDossier'),
    PersonalTaskEvidenceSignal: require('../../models/PersonalTaskEvidenceSignal'),
    PipelineTask: require('../../models/PipelineTask'),
    currentFactFilter: require('./memoryNoteValidity').currentFactFilter,
    momentLink: require('./historyProposalService').momentLink,
  };
}

// What a recall result can be linked by: its message and thread, or its souvenir.
function anchorsOf(result) {
  const metadata = result?.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  if (metadata.source !== 'owner-recall') return null;
  const provenance = metadata.provenance && typeof metadata.provenance === 'object' ? metadata.provenance : {};
  const anchors = {
    messageId: exactIds([provenance.messageId])[0] || null,
    threadId: exactIds([provenance.threadId])[0] || null,
    souvenirNoteId: NOTE_ID.test(String(metadata.souvenirNoteId || '')) ? String(metadata.souvenirNoteId) : null,
  };
  return anchors.messageId || anchors.threadId || anchors.souvenirNoteId ? anchors : null;
}

async function mailJournal(stores, { messageIds, threadIds }, now) {
  if (!messageIds.length && !threadIds.length) return [];
  const rows = await stores.MailJournalEntry.find({ scope: 'owner',
    $and: [
      { $or: [{ threadId: { $in: threadIds } }, ...(messageIds.length ? [{ messageId: { $in: messageIds } }] : [])] },
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
    ] }).sort({ occurredAt: -1, _id: 1 }).limit(PER_STORE).select('threadId messageId occurredAt subject sourceRef').lean();
  return rows.map(row => ({ system: 'mail_journal', id: String(row._id), title: short(row.subject),
    occurredAt: isoDate(row.occurredAt), sourceRef: short(row.sourceRef, 500) || null,
    keys: { messageId: row.messageId || null, threadId: row.threadId || null } }));
}

function momentDate(row) {
  const effective = row.context?.timeline ? { ...row.context.timeline, ...(row.context.overrides || {}) } : null;
  if (effective) return { date: effective.date || null, precision: effective.date ? effective.precision || 'unknown' : 'unknown' };
  return { date: row.eventDate || null, precision: row.eventDate ? row.eventDatePrecision || 'unknown' : 'unknown' };
}

async function lifeHistory(stores, { messageIds, threadIds, souvenirNoteIds }) {
  const or = [
    ...(messageIds.length ? [{ 'source.messageId': { $in: messageIds } }, { 'relatedSources.messageId': { $in: messageIds } }] : []),
    ...(threadIds.length ? [{ 'source.threadId': { $in: threadIds } }, { 'relatedSources.threadId': { $in: threadIds } }] : []),
    ...(souvenirNoteIds.length ? [{ souvenirNoteId: { $in: souvenirNoteIds } }] : []),
  ];
  if (!or.length) return [];
  const rows = await stores.PersonalHistoryEntry.find({ scope: 'owner', reviewState: { $ne: 'forgotten' }, forgottenAt: null, $or: or })
    .sort({ sourceDate: -1, _id: 1 }).limit(PER_STORE)
    .select('text source.messageId source.threadId relatedSources.messageId relatedSources.threadId reviewState assertionState sourceDate eventDate eventDatePrecision souvenirNoteId context.timeline context.overrides')
    .lean();
  return rows.map(row => {
    const effective = row.context?.timeline ? { ...row.context.timeline, ...(row.context.overrides || {}) } : {};
    const id = String(row._id);
    return { system: 'life_history', id, title: short(effective.title || row.text), link: stores.momentLink(id),
      ...momentDate(row), sourceDate: isoDate(row.sourceDate), reviewState: row.reviewState, assertionState: row.assertionState,
      keys: { messageIds: [row.source?.messageId, ...(row.relatedSources || []).map(item => item.messageId)].filter(Boolean),
        threadIds: [row.source?.threadId, ...(row.relatedSources || []).map(item => item.threadId)].filter(Boolean),
        souvenirNoteId: row.souvenirNoteId || null } };
  });
}

async function souvenirs(stores, { messageIds }, now) {
  if (!messageIds.length) return [];
  const rows = await stores.MemoryNote.find({ scope: 'owner', kind: 'souvenir', status: 'active',
    'sourceRefs.id': { $in: messageIds }, ...stores.currentFactFilter(now) })
    .sort({ _id: 1 }).limit(PER_STORE).select('eventDate eventDatePrecision sourceRefs').lean();
  // The note text may be sealed at rest: the link names it, the notes tool reads it.
  return rows.map(row => ({ system: 'memory_note', id: String(row._id), kind: 'souvenir',
    title: row.eventDate ? `Souvenir du ${row.eventDate}` : 'Souvenir',
    date: row.eventDate || null, precision: row.eventDate ? row.eventDatePrecision || 'unknown' : 'unknown',
    keys: { messageIds: (row.sourceRefs || []).map(ref => ref.id) } }));
}

async function personalTasks(stores, { threadIds }) {
  if (!threadIds.length) return [];
  const [dossiers, signals] = await Promise.all([
    stores.PersonalTaskDossier.find({ 'snapshot.selection.threadIds': { $in: threadIds } })
      .limit(PER_STORE).select('taskId snapshot.selection.threadIds').lean(),
    stores.PersonalTaskEvidenceSignal.find({ threadId: { $in: threadIds } })
      .limit(PER_STORE).select('threadId taskIds').lean(),
  ]);
  const threadsByTask = new Map();
  const add = (taskId, threadId) => {
    if (!taskId || !threadIds.includes(threadId)) return;
    if (!threadsByTask.has(taskId)) threadsByTask.set(taskId, new Set());
    threadsByTask.get(taskId).add(threadId);
  };
  dossiers.forEach(row => (row.snapshot?.selection?.threadIds || []).forEach(threadId => add(row.taskId, threadId)));
  signals.forEach(row => (row.taskIds || []).forEach(taskId => add(taskId, row.threadId)));
  if (!threadsByTask.size) return [];
  const tasks = await stores.PipelineTask.find({ service: 'personal', status: { $in: OPEN_TASK },
    pipelineId: { $in: [...threadsByTask.keys()] } }).limit(PER_STORE).select('pipelineId title status').lean();
  return tasks.map(task => ({ system: 'personal_task', id: String(task.pipelineId), title: short(task.title), status: task.status,
    keys: { threadIds: [...threadsByTask.get(task.pipelineId)] } }));
}

function relationFor(record, anchors) {
  const keys = record.keys;
  const messageIds = keys.messageIds || (keys.messageId ? [keys.messageId] : []);
  const threadIds = keys.threadIds || (keys.threadId ? [keys.threadId] : []);
  if (anchors.messageId && messageIds.includes(anchors.messageId)) return 'same_message';
  if (anchors.threadId && threadIds.includes(anchors.threadId)) return 'same_thread';
  if (anchors.souvenirNoteId && keys.souvenirNoteId === anchors.souvenirNoteId) return 'kept_souvenir';
  return null;
}

const RELATION_ORDER = { same_message: 0, kept_souvenir: 1, same_thread: 2 };

// Adds `links` to owner recall results. A store that cannot be read is named in
// `linkStatus.unavailable`; its absence never reads as "no related record".
async function attach(results, { stores = defaultStores(), now = new Date(), logger } = {}) {
  const list = Array.isArray(results) ? results : [];
  const anchors = list.map(anchorsOf);
  const ids = {
    messageIds: exactIds(anchors.map(item => item?.messageId)),
    threadIds: exactIds(anchors.map(item => item?.threadId)),
    souvenirNoteIds: [...new Set(anchors.map(item => item?.souvenirNoteId).filter(Boolean))],
  };
  const lookups = { mail_journal: mailJournal, life_history: lifeHistory, memory_note: souvenirs, personal_task: personalTasks };
  const names = Object.keys(lookups);
  const settled = await Promise.allSettled(names.map(name => lookups[name](stores, ids, now)));
  const records = [], unavailable = [];
  let truncated = false;
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') {
      if (outcome.value.length >= PER_STORE) truncated = true;
      records.push(...outcome.value);
    } else {
      unavailable.push(names[index]);
      logger?.warn?.('Owner context links unavailable for one source', { source: names[index], error: outcome.reason?.message });
    }
  });
  const linked = list.map((result, index) => {
    const anchor = anchors[index];
    if (!anchor) return { ...result, links: [] };
    const matches = records.map(record => ({ record, relation: relationFor(record, anchor) }))
      .filter(item => item.relation && !(item.record.system === 'memory_note' && item.record.id === anchor.souvenirNoteId))
      .sort((left, right) => RELATION_ORDER[left.relation] - RELATION_ORDER[right.relation]);
    if (matches.length > PER_RESULT) truncated = true;
    const links = matches.slice(0, PER_RESULT).map(({ record, relation }) => {
      const { keys: _keys, ...visible } = record;
      return { ...visible, relation };
    });
    return { ...result, links };
  });
  return {
    results: linked,
    linkStatus: {
      basis: 'exact_identifiers',
      complete: unavailable.length === 0 && !truncated,
      unavailable,
      truncated,
    },
  };
}

// The owner's private recall with its links. The audience is bound here, by
// trusted server code: only Nestor's owner contract calls it.
async function recall(query, { limit, read, ...options } = {}) {
  const clean = typeof query === 'string' ? query.trim() : '';
  const reader = read || require('./memoryReadService').forAudience('owner-private');
  const found = await reader.search(clean, { topK: limit });
  const { results, linkStatus } = await attach(found, options);
  return { authority: 'agentx.core', query: clean, results, linkStatus };
}

module.exports = { PER_RESULT, PER_STORE, anchorsOf, attach, recall };

'use strict';

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const { TASK_ORIGINS, taskOrigin, publicTask, sortedPersonalTasks } = require('./personalTaskView');
const { composePersonalBriefing } = require('./personalBriefing');
const { initialTransition } = require('./pipelineTaskTransitions');
const { commitLaneTask } = require('./pipelineLaneTaskMutationService');
const { personalReview, reviewReason } = require('./personalTaskReview');
const { normalizeRepeat, nextPersonalOccurrence } = require('./personalRepeat');

const OPEN_TASK_STATUSES = Object.freeze(['queued', 'in_progress', 'review', 'blocked']);

class PersonalTaskError extends Error {
  constructor(message, { status = 400, code = 'SECRETARY_ERROR', details = null } = {}) {
    super(message);
    this.name = 'PersonalTaskError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function boundedText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function parseDate(value, field, code) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PersonalTaskError(`${field} must be null or an ISO date or datetime`, { code });
  }
  return date;
}

// #287 — dueAt accepts a date (YYYY-MM-DD) or a full ISO datetime.
// A full ISO datetime keeps its explicit instant, offset or Z included. A
// date-only value names the household calendar day in the configured
// household time zone (PLANNING_TIME_ZONE, default America/Toronto): it means
// the end of that day, 23:59:59.999 local — never midnight of the UTC day,
// which lands on the previous household evening when the household is west of
// UTC.
//
// The date is validated, not trusted: '2026-10-04' parses, but '2026-13-40'
// or '2026-10-04extra' do not.
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDueAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) {
    const { endOfHouseholdDay, familyTimeZone } = require('../domains/household/family');
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31
      || new Date(Date.UTC(year, month - 1, day)).getUTCMonth() !== month - 1
      || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) {
      throw new PersonalTaskError('dueAt date is not a real calendar day', { code: 'SECRETARY_BAD_DUE_DATE' });
    }
    return endOfHouseholdDay(text, familyTimeZone());
  }
  return parseDate(text, 'dueAt', 'SECRETARY_BAD_DUE_DATE');
}

function parseRelevantUntil(value) {
  return parseDate(value, 'relevantUntil', 'SECRETARY_BAD_RELEVANT_UNTIL');
}

function parsePriority(value, { fallback = 3, strict = false } = {}) {
  const priority = Number(value);
  if (strict && (!Number.isInteger(priority) || priority < 1 || priority > 5)) {
    throw new PersonalTaskError('priority must be an integer from 1 to 5', { code: 'SECRETARY_BAD_PRIORITY' });
  }
  if (!Number.isFinite(priority)) return fallback;
  return Math.max(1, Math.min(Math.floor(priority), 5));
}

async function personalTaskSnapshot(input = {}, now = new Date()) {
  const query = { service: 'personal' };
  if (input.includeDone !== true && String(input.includeDone || '') !== 'true') query.status = { $in: OPEN_TASK_STATUSES };
  // Classify before paging: old imported reminders must not hide a newly
  // captured deadline. Project only the fields needed by the public view.
  const tasks = await PipelineTask.find(query).select('pipelineId title status priority spec dueAt relevantUntil origin source createdAt updatedAt personalReview personalRepeat personalLastCompletedOccurrence personalDossierDecisions __v').lean();
  const attention = { today: 0, overdue: 1, upcoming: 2, inbox: 3, recheck: 4, expired: 5, review: 6, done: 7, dismissed: 8 };
  const snapshot = sortedPersonalTasks(tasks, now).filter(task => input.includeDone === true || String(input.includeDone) === 'true' || input.scope === 'dismissed' || task.lane !== 'dismissed')
    .sort((a, b) => attention[a.lane] - attention[b.lane]);
  return require('./personalTaskDossierService').summaries(snapshot);
}

async function listPersonalTasks(input = {}, now = new Date()) {
  const snapshot = await personalTaskSnapshot(input, now);
  const review = snapshot.filter(task => task.needsReview);
  const categoryRows = snapshot.filter(task => input.scope === 'dismissed' ? task.lane === 'dismissed' : !['done', 'dismissed'].includes(task.lane));
  const all = snapshot.filter(task => input.scope === 'review' ? task.needsReview : input.scope === 'dismissed' ? task.lane === 'dismissed'
    : input.scope === 'triage' ? ['expired', 'recheck'].includes(task.lane) : input.scope === 'active' ? !task.needsReview : true)
    .filter(task => !input.category || task.category === input.category);
  const limit = Math.max(1, Math.min(Math.floor(Number(input.limit)) || 25, 100));
  const offset = Math.max(0, Math.floor(Number(input.offset)) || 0);
  const items = all.slice(offset, offset + limit);
  return {
    count: items.length,
    totalCount: all.length,
    hasMore: all.length > offset + items.length,
    nextOffset: all.length > offset + items.length ? offset + items.length : null,
    reviewCount: review.length,
    findingCount: input.scope === 'dismissed' ? categoryRows.length : review.length,
    categoryCounts: Object.fromEntries(['action', 'email', 'platform', 'assistant'].map(category => [category, categoryRows.filter(task => task.category === category).length])),
    overdueCount: all.filter((item) => item.overdue).length,
    dueTodayCount: all.filter((item) => item.dueToday).length,
    tasks: items
  };
}

// Reads every open task: the brief must not depend on a listing page size.
async function personalBriefing(now = new Date()) {
  return { source: 'AgentX personal tasks', ...composePersonalBriefing(await personalTaskSnapshot({}, now), now) };
}

async function createPersonalTask(input = {}, { ownerCapture = false } = {}) {
  const title = String(input.title || '').replace(/\s+/g, ' ').trim();
  if (!title) throw new PersonalTaskError('title is required', { code: 'SECRETARY_TITLE_REQUIRED' });
  if (title.length > 200) throw new PersonalTaskError('Use a short action title (at most 200 characters); keep context in note.', { code: 'SECRETARY_TITLE_TOO_LONG' });
  const origin = boundedText(input.origin, 16).toLowerCase();
  if (origin && !TASK_ORIGINS.includes(origin)) throw new PersonalTaskError('origin must be chat, email or manual', { code: 'SECRETARY_BAD_ORIGIN' });
  const reason = reviewReason({ title, origin, note: input.note });
  const ownerAccepted = ownerCapture && reason === 'email';
  const dueAt = parseDueAt(input.dueAt);
  const repeat = normalizeRepeat(input.repeat);
  if (repeat && (!dueAt || input.relevantUntil)) throw new PersonalTaskError('A repeating task needs dueAt and cannot have relevantUntil.', { code: 'PERSONAL_REPEAT_INVALID' });
  if (repeat?.until && new Date(repeat.until) < dueAt) throw new PersonalTaskError('Repeat until precedes the first due date.', { code: 'PERSONAL_REPEAT_INVALID' });
  if (input.requestId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId)) throw new PersonalTaskError('requestId must be a UUID.', { code: 'PERSONAL_CAPTURE_INVALID' });
  const captureId = input.requestId?.toLowerCase();
  const captureFingerprint = require('crypto').createHash('sha256').update(JSON.stringify({ title, dueAt, repeat,
    note: boundedText(input.note, 2000), priority: parsePriority(input.priority), origin,
    relevantUntil: parseRelevantUntil(input.relevantUntil) })).digest('hex');
  const replay = async () => {
    const previous = captureId && await PipelineTask.findOne({ personalCaptureId: captureId, service: 'personal' });
    if (!previous) return null;
    if (previous.personalCaptureFingerprint !== captureFingerprint) throw new PersonalTaskError('This requestId belongs to different task details.', { code: 'PERSONAL_CAPTURE_CONFLICT', status: 409 });
    return publicTask(previous);
  };
  const previous = await replay();
  if (previous) return previous;
  const pipelineId = String(await Counter.next('pipelineTask')).padStart(4, '0');
  let task;
  try { task = await PipelineTask.create({
    pipelineId,
    title,
    spec: boundedText(input.note, 2000),
    service: 'personal',
    status: 'queued',
    epic: 'Personal',
    priority: parsePriority(input.priority),
    dueAt,
    ...(repeat ? { personalRepeat: repeat, personalRepeatAnchor: dueAt } : {}),
    ...(captureId ? { personalCaptureId: captureId, personalCaptureFingerprint: captureFingerprint } : {}),
    relevantUntil: parseRelevantUntil(input.relevantUntil) || undefined,
    source: boundedText(input.source || 'household-secretary', 120),
    origin: origin || taskOrigin({ source: input.source, spec: input.note }),
    // Inputs cannot self-declare a human review. The review endpoint owns it.
    ...(reason ? {
      personalReview: { state: ownerAccepted ? 'accepted' : 'pending', reason,
        reviewedAt: ownerAccepted ? new Date() : null }
    } : {}),
    ...initialTransition(pipelineId, { channel: 'personal_surface', declaredActor: input.by || null })
  }); } catch (error) {
    if (captureId && error.code === 11000) { const captured = await replay(); if (captured) return captured; }
    throw error;
  }
  return publicTask(task);
}

async function resolvePersonalTask(ref, { openOnly = false } = {}) {
  const raw = boundedText(ref, 200);
  if (!raw) throw new PersonalTaskError('ref is required', { code: 'SECRETARY_REF_REQUIRED' });
  if (/^\d{1,4}$/.test(raw)) {
    const task = await PipelineTask.findOne({ pipelineId: raw.padStart(4, '0'), service: 'personal' });
    if (!task) throw new PersonalTaskError(`No personal task matching "${raw}"`, { status: 404, code: 'SECRETARY_TASK_NOT_FOUND' });
    if (openOnly && !OPEN_TASK_STATUSES.includes(task.status)) {
      throw new PersonalTaskError('Only an open personal task can be changed', { status: 409, code: 'SECRETARY_TASK_CLOSED' });
    }
    return task;
  }
  const open = await PipelineTask.find({ service: 'personal', status: { $in: OPEN_TASK_STATUSES } });
  const needle = raw.toLowerCase();
  const matches = open.filter((task) => String(task.title || '').toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new PersonalTaskError(`No open personal task matching "${raw}"`, { status: 404, code: 'SECRETARY_TASK_NOT_FOUND' });
  throw new PersonalTaskError(`"${raw}" matches more than one task`, {
    status: 409,
    code: 'SECRETARY_AMBIGUOUS_REF',
    details: { candidates: matches.map((task) => ({ id: task.pipelineId, title: boundedText(task.title, 200) })) }
  });
}

async function updatePersonalTask(input = {}) {
  const raw = boundedText(input.ref, 20);
  if (!/^\d{1,4}$/.test(raw)) throw new PersonalTaskError('ref must be a numeric personal task id', { code: 'SECRETARY_REF_REQUIRED' });
  const hasDueAt = Object.prototype.hasOwnProperty.call(input, 'dueAt');
  const hasPriority = Object.prototype.hasOwnProperty.call(input, 'priority');
  const hasRelevantUntil = Object.prototype.hasOwnProperty.call(input, 'relevantUntil');
  const hasRepeat = Object.prototype.hasOwnProperty.call(input, 'repeat');
  if (!hasDueAt && !hasPriority && !hasRelevantUntil && !hasRepeat) {
    throw new PersonalTaskError('dueAt, priority or relevantUntil is required', { code: 'SECRETARY_UPDATE_REQUIRED' });
  }
  const task = await resolvePersonalTask(raw, { openOnly: true });
  if (Object.hasOwn(input, 'revision') && (!Number.isInteger(input.revision) || input.revision !== (task.__v ?? 0))) {
    throw new PersonalTaskError('Cette action a changé. Actualisez la liste avant de réessayer.', { status: 409, code: 'SECRETARY_EDIT_CONFLICT' });
  }
  const changes = [];
  const fields = {};
  if (hasDueAt) {
    fields.dueAt = parseDueAt(input.dueAt);
    changes.push(fields.dueAt ? `due ${fields.dueAt.toISOString()}` : 'due date cleared');
  }
  if (hasPriority) {
    fields.priority = parsePriority(input.priority, { strict: true });
    changes.push(`priority ${fields.priority}`);
  }
  if (hasRelevantUntil) {
    fields.relevantUntil = parseRelevantUntil(input.relevantUntil);
    changes.push(fields.relevantUntil ? `relevant until ${fields.relevantUntil.toISOString()}` : 'relevance date cleared');
  }
  if (hasRepeat) { fields.personalRepeat = normalizeRepeat(input.repeat); changes.push('repeat updated'); }
  const repeat = hasRepeat ? fields.personalRepeat : task.personalRepeat;
  const dueAt = hasDueAt ? fields.dueAt : task.dueAt;
  if (repeat && (!dueAt || (hasRelevantUntil ? fields.relevantUntil : task.relevantUntil))) throw new PersonalTaskError('A repeating task needs dueAt and cannot have relevantUntil.', { code: 'PERSONAL_REPEAT_INVALID' });
  if (repeat && (hasRepeat || hasDueAt)) fields.personalRepeatAnchor = dueAt;
  const updated = await commitLaneTask(task, { fields, channel: 'personal_surface',
    feedback: { by: boundedText(input.by || 'household-dad-desk', 120), text: `Personal desk update: ${changes.join(', ')}.` } });
  return publicTask(updated);
}

async function completePersonalTask(input = {}) {
  const task = await resolvePersonalTask(input.ref);
  if (task.status === 'done') return { alreadyDone: true, task: publicTask(task) };
  if (personalReview(task).state !== 'accepted') {
    throw new PersonalTaskError('Review this proposal in My day before completing it.', { status: 409, code: 'SECRETARY_REVIEW_REQUIRED' });
  }
  if (task.personalRepeat && input.stopRepeat !== true) {
    const expected = parseDate(input.expectedDueAt, 'expectedDueAt', 'PERSONAL_OCCURRENCE_REQUIRED');
    if (!expected) throw new PersonalTaskError('Read the task and pass its dueAt as expectedDueAt for a repeating completion.', { code: 'PERSONAL_OCCURRENCE_REQUIRED' });
    if (task.personalLastCompletedOccurrence && +expected === +task.personalLastCompletedOccurrence) return { alreadyDone: true, task: publicTask(task) };
    if (+expected !== +task.dueAt) throw new PersonalTaskError('The task occurrence has changed; read it again.', { code: 'PERSONAL_OCCURRENCE_CONFLICT', status: 409 });
    const next = nextPersonalOccurrence(task.personalRepeat, task.personalRepeatAnchor || task.dueAt,
      new Date(Math.max(+task.dueAt, Date.now())));
    const updated = await commitLaneTask(task, { fields: { status: next ? 'queued' : 'done',
      ...(next ? { dueAt: next } : {}), personalLastCompletedOccurrence: task.dueAt }, channel: 'personal_surface',
      feedback: { by: boundedText(input.by || 'nestor-secretary', 120), text: next ? `Occurrence completed; next due ${next.toISOString()}.` : 'Final occurrence completed.' } });
    return { alreadyDone: false, recurring: Boolean(next), task: publicTask(updated) };
  }
  const by = boundedText(input.by || 'household-secretary', 120);
  const updated = await commitLaneTask(task, {
    fields: { status: 'done', assignee: null, heartbeatAt: null },
    feedback: { by, text: boundedText(input.note || 'Completed via the household secretary lane.', 2000) },
    kind: 'personal_completed', channel: 'personal_surface', declaredActor: by,
  });
  return { alreadyDone: false, task: publicTask(updated) };
}

// Human action editor. The model update contract remains date/priority only.
async function editPersonalAction(input = {}) {
  if (!/^\d{1,4}$/.test(String(input.ref || ''))) {
    throw new PersonalTaskError('Identifiant de tâche requis.', { code: 'SECRETARY_REF_REQUIRED' });
  }
  const task = await resolvePersonalTask(input.ref, { openOnly: true });
  if (!Number.isInteger(input.revision) || input.revision !== (task.__v ?? 0)) {
    throw new PersonalTaskError('Cette action a changé. Actualisez la liste avant de réessayer.', { status: 409, code: 'SECRETARY_EDIT_CONFLICT' });
  }
  if (personalReview(task).state !== 'accepted') {
    throw new PersonalTaskError('Validez cette proposition dans les courriels.', { status: 409, code: 'SECRETARY_REVIEW_REQUIRED' });
  }
  const title = String(input.title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 200 || !Object.hasOwn(input, 'dueAt')) {
    throw new PersonalTaskError('Indiquez une action courte et une date, ou laissez la date vide.', { code: 'SECRETARY_REVIEW_ACTION_REQUIRED' });
  }
  if (['platform', 'assistant'].includes(reviewReason({ title }))) {
    throw new PersonalTaskError('Ce suivi appartient au dossier technique ou au Secrétariat.', { code: 'SECRETARY_NOT_PERSONAL_ACTION' });
  }
  const dueAt = parseDueAt(input.dueAt);
  if (task.personalRepeat && !dueAt) throw new PersonalTaskError('A repeating task needs a due date.', { code: 'PERSONAL_REPEAT_INVALID' });
  const updated = await commitLaneTask(task, { channel: 'personal_surface',
    fields: { title, dueAt, priority: parsePriority(input.priority, { strict: true }),
      ...(task.personalRepeat && +dueAt !== +task.dueAt ? { personalRepeatAnchor: dueAt } : {}) },
    feedback: { by: 'household-dad-desk', text: `Personal action edited; previous wording: ${task.title}; previous deadline: ${task.dueAt?.toISOString() || 'none'}; previous priority: ${task.priority}.` } });
  return publicTask(updated);
}

async function reviewPersonalTask(input = {}) {
  if (!/^\d{1,4}$/.test(String(input.ref || ''))) {
    throw new PersonalTaskError('ref must be a numeric personal task id', { code: 'SECRETARY_REF_REQUIRED' });
  }
  if (!['accept', 'dismiss', 'restore'].includes(input.decision)) {
    throw new PersonalTaskError('decision must be accept, dismiss or restore', { code: 'SECRETARY_BAD_REVIEW' });
  }
  const task = await resolvePersonalTask(input.ref, { openOnly: true });
  if (personalReview(task).state !== (input.decision === 'restore' ? 'dismissed' : 'pending') || !Number.isInteger(input.revision) || input.revision !== (task.__v ?? 0)) {
    throw new PersonalTaskError('This proposal changed. Reload it before reviewing.', { status: 409, code: 'SECRETARY_REVIEW_CONFLICT' });
  }
  const state = { accept: 'accepted', dismiss: 'dismissed', restore: 'pending' }[input.decision];
  const fields = { personalReview: { ...personalReview(task), state, reviewedAt: new Date() } };
  if (input.decision === 'accept') {
    const title = String(input.title || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 200 || !Object.hasOwn(input, 'dueAt')) {
      throw new PersonalTaskError('Review a short action title and choose a due date or null.', { code: 'SECRETARY_REVIEW_ACTION_REQUIRED' });
    }
    const reason = reviewReason({ title });
    if (reason === 'platform' || reason === 'assistant') {
      throw new PersonalTaskError('Platform work belongs in Pipeline; assistant reading stays in the source dossier.', { code: 'SECRETARY_NOT_PERSONAL_ACTION' });
    }
    fields.title = title;
    // Explicit choice: never silently keep an extractor's inferred deadline.
    fields.dueAt = parseDueAt(input.dueAt);
    fields.relevantUntil = parseRelevantUntil(input.relevantUntil);
  }
  const updated = await commitLaneTask(task, { fields, channel: 'personal_surface',
    feedback: { by: 'household-dad-desk', text: `Personal proposal ${state}; original title: ${task.title}` } });
  return publicTask(updated);
}

module.exports = {
  OPEN_TASK_STATUSES,
  PersonalTaskError,
  completePersonalTask,
  createPersonalTask,
  editPersonalAction,
  listPersonalTasks,
  parseDueAt,
  personalBriefing,
  personalTaskSnapshot,
  parsePriority,
  resolvePersonalTask,
  reviewPersonalTask,
  updatePersonalTask
};

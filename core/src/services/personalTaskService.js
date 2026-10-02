'use strict';

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const { TASK_ORIGINS, taskOrigin, publicTask, sortedPersonalTasks } = require('./personalTaskView');
const { composePersonalBriefing } = require('./personalBriefing');
const { initialTransition } = require('./pipelineTaskTransitions');
const { commitLaneTask } = require('./pipelineLaneTaskMutationService');

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

function parseDueAt(value) {
  return parseDate(value, 'dueAt', 'SECRETARY_BAD_DUE_DATE');
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

async function listPersonalTasks(input = {}, now = new Date()) {
  const query = { service: 'personal' };
  if (input.includeDone !== true && String(input.includeDone || '') !== 'true') query.status = { $in: OPEN_TASK_STATUSES };
  const limit = Math.max(1, Math.min(Number(input.limit) || 25, 100));
  const tasks = await PipelineTask.find(query).limit(limit).lean();
  const items = sortedPersonalTasks(tasks, now);
  return {
    count: items.length,
    overdueCount: items.filter((item) => item.overdue).length,
    dueTodayCount: items.filter((item) => item.dueToday).length,
    tasks: items
  };
}

// Reads every open task: the brief must not depend on a listing page size.
async function personalBriefing(now = new Date()) {
  const tasks = await PipelineTask.find({ service: 'personal', status: { $in: OPEN_TASK_STATUSES } }).limit(1000).lean();
  return { source: 'AgentX personal tasks', ...composePersonalBriefing(sortedPersonalTasks(tasks, now), now) };
}

async function createPersonalTask(input = {}) {
  const title = boundedText(input.title, 200);
  if (!title) throw new PersonalTaskError('title is required', { code: 'SECRETARY_TITLE_REQUIRED' });
  const origin = boundedText(input.origin, 16).toLowerCase();
  if (origin && !TASK_ORIGINS.includes(origin)) throw new PersonalTaskError('origin must be chat, email or manual', { code: 'SECRETARY_BAD_ORIGIN' });
  const pipelineId = String(await Counter.next('pipelineTask')).padStart(4, '0');
  const task = await PipelineTask.create({
    pipelineId,
    title,
    spec: boundedText(input.note, 2000),
    service: 'personal',
    status: 'queued',
    epic: 'Personal',
    priority: parsePriority(input.priority),
    dueAt: parseDueAt(input.dueAt),
    relevantUntil: parseRelevantUntil(input.relevantUntil) || undefined,
    source: boundedText(input.source || 'household-secretary', 120),
    origin: origin || taskOrigin({ source: input.source, spec: input.note }),
    ...initialTransition(pipelineId, { channel: 'personal_surface', declaredActor: input.by || null })
  });
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
  if (!hasDueAt && !hasPriority && !hasRelevantUntil) {
    throw new PersonalTaskError('dueAt, priority or relevantUntil is required', { code: 'SECRETARY_UPDATE_REQUIRED' });
  }
  const task = await resolvePersonalTask(raw, { openOnly: true });
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
  const updated = await commitLaneTask(task, { fields, channel: 'personal_surface',
    feedback: { by: boundedText(input.by || 'household-dad-desk', 120), text: `Personal desk update: ${changes.join(', ')}.` } });
  return publicTask(updated);
}

async function completePersonalTask(input = {}) {
  const task = await resolvePersonalTask(input.ref);
  if (task.status === 'done') return { alreadyDone: true, task: publicTask(task) };
  const by = boundedText(input.by || 'household-secretary', 120);
  const updated = await commitLaneTask(task, {
    fields: { status: 'done', assignee: null, heartbeatAt: null },
    feedback: { by, text: boundedText(input.note || 'Completed via the household secretary lane.', 2000) },
    kind: 'personal_completed', channel: 'personal_surface', declaredActor: by,
  });
  return { alreadyDone: false, task: publicTask(updated) };
}

module.exports = {
  OPEN_TASK_STATUSES,
  PersonalTaskError,
  completePersonalTask,
  createPersonalTask,
  listPersonalTasks,
  parseDueAt,
  personalBriefing,
  parsePriority,
  resolvePersonalTask,
  updatePersonalTask
};

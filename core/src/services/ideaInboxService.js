'use strict';

// The idea inbox (#13). Nestor and the family surfaces keep raw ideas and
// reminders as Planning ideas in `inbox`; the parent reviews them and either
// promotes one to a personal task or a pipeline task, or sets it aside. An idea
// never exists as a queued pipeline row before that review.
const mongoose = require('mongoose');
const PlanningItem = require('../../models/PlanningItem');
const { cleanProfileId } = require('../domains/household/family');

const ORIGINS = Object.freeze(['nestor', 'family']);
const KINDS = Object.freeze(['idea', 'reminder']);
const REVIEWABLE = Object.freeze(['inbox', 'triaged']);
const EXECUTION_TARGETS = Object.freeze(['personal', 'task']);
const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const planning = () => require('./planningService');

function tagValue(tags, prefix) {
  const tag = (tags || []).find((entry) => String(entry).startsWith(`${prefix}:`));
  return tag ? String(tag).slice(prefix.length + 1) : '';
}

function publicIdea(item) {
  const tags = item.tags || [];
  return {
    id: String(item._id || item.id),
    title: item.title,
    text: item.summary || item.title,
    status: item.status,
    origin: tagValue(tags, 'origin') || 'planning',
    kind: tagValue(tags, 'kind') || 'idea',
    profileId: tagValue(tags, 'profile') || null,
    createdAt: item.createdAt || null,
    promotedTask: item.promotedTask?.pipelineId ? { ...item.promotedTask } : null
  };
}

// The user's words stay whole in the summary; the title is their first line.
async function captureIdea(input = {}) {
  const words = text(input.text, 2000);
  if (!words) throw failure(400, 'IDEA_TEXT_REQUIRED', 'text is required');
  const origin = ORIGINS.includes(input.origin) ? input.origin : 'nestor';
  const kind = KINDS.includes(input.kind) ? input.kind : 'idea';
  const profileId = text(input.profileId, 80) ? cleanProfileId(input.profileId) : '';
  const area = (Array.isArray(input.tags) ? input.tags : []).map((tag) => text(tag, 40)).filter(Boolean).slice(0, 5);
  const item = await planning().createItem({
    type: 'idea',
    title: words.slice(0, 120),
    summary: words,
    tags: [`origin:${origin}`, `kind:${kind}`, ...(profileId ? [`profile:${profileId}`] : []), ...area],
    owner: origin === 'family' ? 'household-family' : 'nestor',
    by: origin === 'family' ? 'household-family' : 'nestor-secretary'
  });
  return { idea: publicIdea(item), review: 'parent' };
}

async function listIdeas({ limit = 30 } = {}) {
  const rows = await PlanningItem.find({ type: 'idea', status: { $in: REVIEWABLE }, archivedAt: null })
    .sort({ createdAt: -1 }).limit(Math.max(1, Math.min(100, Number(limit) || 30))).lean();
  return { ideas: rows.map(publicIdea) };
}

async function reviewableIdea(id) {
  if (!mongoose.isValidObjectId(id)) throw failure(400, 'IDEA_BAD_ID', 'id is invalid');
  const item = await PlanningItem.findById(id).lean();
  if (!item) throw failure(404, 'IDEA_NOT_FOUND', 'Idea not found');
  if (item.type !== 'idea') throw failure(400, 'NOT_AN_IDEA', 'Only ideas can be promoted');
  return { ...item, id: String(item._id) };
}

// The parent's review is the shaping step, so an inbox idea may be promoted to
// execution directly. A pipeline task carries sourceKey idea:<id>, so a retry
// after a partial failure reuses the task instead of creating a second one.
async function promoteToExecution(id, input = {}, deps = {}) {
  const idea = await reviewableIdea(id);
  const targetType = input.targetType;
  if (!EXECUTION_TARGETS.includes(targetType)) throw failure(400, 'IDEA_BAD_TARGET', 'targetType must be personal or task');
  if (!REVIEWABLE.includes(idea.status)) throw failure(409, 'IDEA_ALREADY_REVIEWED', `Idea is ${idea.status}`);
  const title = text(input.title || idea.title, 120);
  const summary = text(input.summary || idea.summary || idea.title, 2000);
  const by = text(input.by, 120) || 'household-dad-desk';
  let task;
  if (targetType === 'task') {
    const createTask = deps.createTask || require('./pipelineTaskService').createTaskInMongo;
    task = await createTask({ title, objective: summary, service: text(input.service, 120) || undefined,
      source: 'planning-idea', sourceKey: `idea:${idea.id}` });
  } else {
    const createPersonal = deps.createPersonalTask || require('./personalTaskService').createPersonalTask;
    task = await createPersonal({ title, note: summary, dueAt: input.dueAt, priority: input.priority,
      source: 'planning-idea', origin: 'manual' });
  }
  const pipelineId = String(task.pipelineId || task.id);
  const updated = await PlanningItem.findOneAndUpdate(
    { _id: idea.id, status: { $in: REVIEWABLE } },
    { $set: { status: 'promoted', promotedTask: { kind: targetType, pipelineId } },
      $push: { history: { $each: [{ action: 'promoted', by, note: `Promoted to ${targetType} #${pipelineId}`,
        metadata: { targetType, pipelineId }, at: new Date() }], $slice: -100 } } },
    { new: true }
  ).lean();
  if (!updated) throw failure(409, 'IDEA_ALREADY_REVIEWED', 'Idea was reviewed meanwhile');
  return { idea: publicIdea(updated), task: { kind: targetType, pipelineId, title } };
}

async function setAside(id, input = {}) {
  const idea = await reviewableIdea(id);
  if (!REVIEWABLE.includes(idea.status)) throw failure(409, 'IDEA_ALREADY_REVIEWED', `Idea is ${idea.status}`);
  const action = input.action === 'park' ? 'park' : 'reject';
  const item = await planning().transitionItem(id, action, { by: text(input.by, 120) || 'household-dad-desk' });
  return { idea: publicIdea(item) };
}

module.exports = { EXECUTION_TARGETS, KINDS, ORIGINS, captureIdea, listIdeas, promoteToExecution, publicIdea, setAside };

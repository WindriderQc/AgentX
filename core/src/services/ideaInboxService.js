'use strict';

// The idea inbox (#13). Nestor and the family surfaces keep raw ideas and
// reminders as Planning ideas in `inbox`; the parent reviews them and either
// promotes one to a personal task, a pipeline task, a memory note or (for a
// proposed chore, #864) a family chore, or sets it aside. An idea never exists
// as a queued pipeline row before that review.
const mongoose = require('mongoose');
const PlanningItem = require('../../models/PlanningItem');
const { cleanProfileId, familyChoreProposal } = require('../domains/household/family');

const ORIGINS = Object.freeze(['nestor', 'family', 'secretary']);
// A capture that names its source once (for example a mail finding) is idempotent.
const SOURCE_KEY = /^[a-z0-9][a-z0-9-]{7,63}$/;
const KINDS = Object.freeze(['idea', 'reminder']);
const FAMILY_CHORE_KIND = 'family_chore';
const REVIEWABLE = Object.freeze(['inbox', 'triaged']);
// A fact the Secretary found (tag memoire) may also become a personal memory note.
const EXECUTION_TARGETS = Object.freeze(['personal', 'task', 'memory', 'family_chore']);
// What the parent may still change on a proposed chore while creating it.
const CHORE_OVERRIDES = Object.freeze(['title', 'note', 'profileId', 'cadence', 'intervalDays', 'winterIntervalDays', 'stars', 'dueAt']);
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
    memory: tags.includes('memoire'),
    profileId: tagValue(tags, 'profile') || null,
    familyChore: item.familyChore?.title ? { ...item.familyChore } : null,
    createdAt: item.createdAt || null,
    promotedTask: item.promotedTask?.pipelineId ? { ...item.promotedTask } : null
  };
}

// The user's words stay whole in the summary; the title is their first line.
async function captureIdea(input = {}) {
  const words = text(input.text, 2000);
  if (!words) throw failure(400, 'IDEA_TEXT_REQUIRED', 'text is required');
  const origin = ORIGINS.includes(input.origin) ? input.origin : 'nestor';
  const kind = [...KINDS, FAMILY_CHORE_KIND].includes(input.kind) ? input.kind : 'idea';
  const profileId = text(input.profileId, 80) ? cleanProfileId(input.profileId) : '';
  const area = (Array.isArray(input.tags) ? input.tags : []).map((tag) => text(tag, 40)).filter(Boolean).slice(0, 5);
  if (input.sourceKey !== undefined && !SOURCE_KEY.test(String(input.sourceKey))) {
    throw failure(400, 'IDEA_BAD_SOURCE_KEY', 'sourceKey is invalid');
  }
  const sourceTag = input.sourceKey ? `source:${input.sourceKey}` : '';
  if (sourceTag) {
    const existing = await PlanningItem.findOne({ type: 'idea', tags: sourceTag }).lean();
    if (existing) return { idea: publicIdea(existing), review: 'parent', duplicate: true };
  }
  const item = await planning().createItem({
    type: 'idea',
    title: words.slice(0, 120),
    summary: words,
    tags: [`origin:${origin}`, `kind:${kind}`, ...(profileId ? [`profile:${profileId}`] : []), ...(sourceTag ? [sourceTag] : []), ...area],
    owner: origin === 'family' ? 'household-family' : 'nestor',
    by: origin === 'family' ? 'household-family' : origin === 'secretary' ? 'secretary-catchup' : 'nestor-secretary'
  });
  return { idea: publicIdea(item), review: 'parent' };
}

// An agent proposes one family chore (#864). It waits in the inbox, with the
// chore as the child would see it, until the parent creates or sets it aside.
async function proposeFamilyChore(input = {}) {
  const chore = familyChoreProposal(input);
  if (input.sourceKey !== undefined && !SOURCE_KEY.test(String(input.sourceKey))) {
    throw failure(400, 'IDEA_BAD_SOURCE_KEY', 'sourceKey is invalid');
  }
  const why = text(input.reason, 500);
  const captured = await captureIdea({
    text: `Proposed chore: ${chore.title}${why ? ` — ${why}` : ''}`, origin: 'nestor', kind: FAMILY_CHORE_KIND,
    profileId: chore.profileId || undefined, sourceKey: input.sourceKey,
    tags: chore.subjectRef ? [chore.subjectRef.split(':')[0]] : []
  });
  if (captured.duplicate) return captured;
  const item = await PlanningItem.findByIdAndUpdate(captured.idea.id, { $set: { familyChore: chore } }, { new: true }).lean();
  return { idea: publicIdea(item), review: 'parent' };
}

function choreOverrides(input = {}) {
  return Object.fromEntries(CHORE_OVERRIDES.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
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
  if (!EXECUTION_TARGETS.includes(targetType)) throw failure(400, 'IDEA_BAD_TARGET', 'targetType must be personal, task, memory or family_chore');
  if (targetType === 'memory' && !(idea.tags || []).includes('memoire')) throw failure(400, 'IDEA_NOT_A_FACT', 'Only a fact to remember becomes a memory note');
  if (targetType === 'family_chore' && !idea.familyChore?.title) throw failure(400, 'IDEA_NOT_A_CHORE', 'Only a proposed chore becomes a family chore');
  if (!REVIEWABLE.includes(idea.status)) throw failure(409, 'IDEA_ALREADY_REVIEWED', `Idea is ${idea.status}`);
  const title = text(input.title || idea.title, 120);
  const summary = text(input.summary || idea.summary || idea.title, 2000);
  const by = text(input.by, 120) || 'household-dad-desk';
  let task;
  if (targetType === 'memory') {
    // The note keeps the fact itself, without the inbox label or the mail link.
    const fact = summary.replace(/^À retenir\s*:\s*/, '').replace(/\s+—\s+https:\/\/mail\.google\.com\/\S+$/, '').trim();
    const remember = deps.remember || ((input) => require('./memoryNoteService').personal().remember(input));
    const note = await remember({ text: fact, kind: 'fact', source: 'idea-inbox' });
    task = { pipelineId: note.id };
  } else if (targetType === 'family_chore') {
    const { subjectRef, ...proposal } = idea.familyChore;
    const createChore = deps.createFamilyChore || ((routine, origin) => require('./familyTaskService').create(routine, origin));
    const { chore } = await createChore({ ...proposal, ...choreOverrides(input) },
      { source: 'planning-idea', sourceKey: `idea:${idea.id}`, subjectRef });
    task = { pipelineId: chore.id, title: chore.title };
  } else if (targetType === 'task') {
    const createTask = deps.createTask || require('./pipelineTaskService').createTaskInMongo;
    task = await createTask({ title, objective: summary, service: text(input.service, 120) || undefined,
      source: 'planning-idea', sourceKey: `idea:${idea.id}` }, { intakeAcceptance: {
      by, reason: 'The operator promoted this reviewed idea into an engineering commitment.', ref: `planning-idea:${idea.id}` } });
  } else {
    const createPersonal = deps.createPersonalTask || require('./personalTaskService').createPersonalTask;
    task = await createPersonal({ title, note: summary, dueAt: input.dueAt, priority: input.priority,
      source: 'planning-idea', origin: 'manual' }, { ownerCapture: true });
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
  return { idea: publicIdea(updated), task: { kind: targetType, pipelineId, title: task.title || title } };
}

async function setAside(id, input = {}) {
  const idea = await reviewableIdea(id);
  if (!REVIEWABLE.includes(idea.status)) throw failure(409, 'IDEA_ALREADY_REVIEWED', `Idea is ${idea.status}`);
  const action = input.action === 'park' ? 'park' : 'reject';
  const item = await planning().transitionItem(id, action, { by: text(input.by, 120) || 'household-dad-desk' });
  return { idea: publicIdea(item) };
}

module.exports = { EXECUTION_TARGETS, KINDS, ORIGINS, captureIdea, listIdeas, promoteToExecution, proposeFamilyChore, publicIdea, setAside };

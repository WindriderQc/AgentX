'use strict';

const Signal = require('../../models/PersonalTaskEvidenceSignal');
const Task = require('../../models/PipelineTask');
const Dossier = require('../../models/PersonalTaskDossier');
const { sourceUrl } = require('./personalTaskReview');
const { digest } = require('./personalTaskDossierSources');
const bad = message => Object.assign(new Error(message), { status: 400, code: 'PERSONAL_DOSSIER_SIGNAL_INVALID' });
const clean = (value, length) => {
  if (typeof value !== 'string' || value.length > length || value.includes('\0')) throw bad('Invalid source finding.');
  return value.trim();
};

async function linkedTasks(threadId) {
  // A task created manually may have no original mail URL. Its saved owner
  // dossier already records the selected thread: retain that association for
  // later findings without rewriting the task or accepting any new duty.
  const reviewedIds = new Set(await Dossier.distinct('taskId', { 'snapshot.selection.threadIds': threadId }));
  const rows = await Task.find({ service: 'personal', status: { $in: ['queued', 'in_progress', 'review', 'blocked'] },
    $or: [{ spec: { $regex: threadId } }, { pipelineId: { $in: [...reviewedIds] } }] }).select('pipelineId spec').lean();
  return rows.filter(row => reviewedIds.has(row.pipelineId) || sourceUrl(row)?.endsWith(`/${threadId}`)).map(row => row.pipelineId);
}

// A page finding only asks for a fresh dossier read. It neither resolves a task
// nor turns another person's request into the owner's accepted commitment.
async function capture(input, taskIds) {
  if (input.findingKey !== undefined) input = { ...input, key: input.findingKey };
  if (!/^[a-f0-9]{32}$/.test(input.key || '') || !/^[a-f0-9]{10,32}$/.test(input.threadId || '')
      || !/^[a-f0-9]{10,32}$/.test(input.messageId || '') || !Number.isFinite(Date.parse(input.sourceDate))) throw bad('A signal needs exact source identities and its date.');
  if (!['current', 'waiting', 'resolved', 'historical', 'uncertain'].includes(input.sourceStatus)) throw bad('Invalid source status.');
  const value = { key: input.key, threadId: input.threadId, messageId: input.messageId,
    sourceDate: new Date(input.sourceDate), text: clean(input.text, 4000), actor: clean(input.owner || '', 300), sourceStatus: input.sourceStatus };
  if (!value.text) throw bad('Source text is required.');
  const fingerprint = digest(value);
  let existing = await Signal.findOne({ key: value.key }).lean();
  let duplicate = Boolean(existing);
  if (!existing) {
    try { existing = (await Signal.create({ ...value, fingerprint, taskIds })).toObject(); }
    catch (error) { if (error.code !== 11000) throw error; existing = await Signal.findOne({ key: value.key }).lean(); duplicate = true; }
  }
  if (existing.fingerprint !== fingerprint) throw Object.assign(bad('The source key already records a different finding.'), { status: 409 });
  return { signal: { id: String(existing._id), sourceStatus: existing.sourceStatus, taskIds: existing.taskIds,
    effect: 'review_required_no_task_change' }, duplicate };
}

async function route(input) {
  if (!['action', 'recheck'].includes(input.kind) || !/^[a-f0-9]{10,32}$/.test(input.threadId || '')) return null;
  const matches = await linkedTasks(input.threadId);
  if (input.kind === 'action' && !matches.length) return null;
  return capture(input, matches);
}

async function forThreads(ids) {
  return Signal.find({ threadId: { $in: ids } }).sort({ sourceDate: -1 }).limit(100).select('-__v -fingerprint').lean();
}

async function summaries(tasks) {
  const ids = tasks.map(task => task.id);
  const rows = await Signal.aggregate([
    { $match: { taskIds: { $in: ids } } }, { $sort: { sourceDate: -1, _id: -1 } },
    { $unwind: '$taskIds' }, { $match: { taskIds: { $in: ids } } },
    { $group: { _id: '$taskIds', count: { $sum: 1 }, latestDate: { $first: '$sourceDate' }, messageId: { $first: '$messageId' } } }
  ]);
  return tasks.map(task => {
    const linked = rows.find(row => row._id === task.id);
    return linked ? { ...task, evidenceSignals: { count: linked.count, latestDate: linked.latestDate,
      latestUrl: `https://mail.google.com/mail/#all/${linked.messageId}`, state: 'needs_reconciliation' } } : task;
  });
}
module.exports = { route, capture, linkedTasks, forThreads, summaries };

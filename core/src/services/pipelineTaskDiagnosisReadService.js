'use strict';

const PipelineTask = require('../../models/PipelineTask');
const PipelineAutomationSlot = require('../../models/PipelineAutomationSlot');
const workerTaskScope = require('../helpers/workerTaskScope');
const { AUTOMATION_SLOT_ID } = require('./pipelineTaskService');
const { diagnoseTask, CATEGORIES } = require('./pipelineTaskDiagnosis');

// Bounded reads only. Nothing here writes, claims, releases or re-queues.
const ACTIVE_STATUSES = ['queued', 'in_progress', 'review', 'blocked'];
const MAX_SCAN = 500;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
// Most ambiguous first; routine waits and observed execution are counted only.
const LISTED = ['recovery_required', 'unknown', 'human_decision', 'dependency'];
const DIAGNOSIS_FIELDS = {
  pipelineId: 1, status: 1, assignee: 1, heartbeatAt: 1, service: 1, source: 1, dependsOn: 1,
  notBefore: 1, dueAt: 1, risk: 1, automation: 1, automationAttemptCount: 1, automationLease: 1,
  'automationAttempts.attempt': 1, 'automationAttempts.completedAt': 1, 'automationAttempts.finalState': 1,
  'automationAttempts.evidence.schema': 1, 'automationAttempts.evidence.failureCodes': 1,
  transitionSeq: 1, transitions: { $slice: -1 }, updatedAt: 1,
};

async function loadDependencies(tasks) {
  const ids = [...new Set(tasks.flatMap(task => task.dependsOn || []))];
  if (!ids.length) return new Map();
  const rows = await PipelineTask.find({ pipelineId: { $in: ids } }).select('pipelineId status').lean();
  return new Map(rows.map(row => [row.pipelineId, { status: row.status }]));
}

// The slot is read after the tasks; a lease renewed in between keeps the same
// lease id, so only a different or missing lease is reported as a mismatch.
async function loadSlot() {
  return (await PipelineAutomationSlot.findById(AUTOMATION_SLOT_ID).select('leaseId pipelineId expiresAt').lean()) || null;
}

async function readTaskDiagnosis(pipelineId, { now = new Date() } = {}) {
  const task = await PipelineTask.findOne({ pipelineId }).select(DIAGNOSIS_FIELDS).lean();
  if (!task) return null;
  const [dependencies, slot] = await Promise.all([loadDependencies([task]), loadSlot()]);
  return diagnoseTask(task, { now, dependencies, slot });
}

// Internal page for the alert reconciler. The public list remains capped at
// 100, while this cursor lets a complete scan visit every engineering task.
async function readEscalationPage({ after = null, now = new Date() } = {}) {
  const query = { status: { $in: ACTIVE_STATUSES }, ...workerTaskScope() };
  if (after) query.pipelineId = { $gt: after };
  const tasks = await PipelineTask.find(query).select(DIAGNOSIS_FIELDS)
    .sort({ pipelineId: 1 }).limit(MAX_SCAN).lean();
  const [dependencies, slot] = await Promise.all([loadDependencies(tasks), loadSlot()]);
  return {
    next: tasks.length === MAX_SCAN ? tasks.at(-1).pipelineId : null,
    items: tasks.map(task => diagnoseTask(task, { now, dependencies, slot }))
      .filter(item => item.escalation),
  };
}

function parseLimit(value) {
  if (value === undefined || value === '') return DEFAULT_LIMIT;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

async function readStalledTaskDiagnoses({ limit = DEFAULT_LIMIT, now = new Date() } = {}) {
  // Engineering scope only, like the attention queue's default scope: private
  // lanes are neither counted nor listed here.
  const tasks = await PipelineTask.find({ status: { $in: ACTIVE_STATUSES }, ...workerTaskScope() })
    .select(DIAGNOSIS_FIELDS).sort({ pipelineId: 1 }).limit(MAX_SCAN + 1).lean();
  const scanned = tasks.slice(0, MAX_SCAN);
  const [dependencies, slot] = await Promise.all([loadDependencies(scanned), loadSlot()]);
  const diagnoses = scanned.map(task => diagnoseTask(task, { now, dependencies, slot }));
  const counts = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  for (const item of diagnoses) counts[item.category] += 1;
  const listed = diagnoses.filter(item => LISTED.includes(item.category))
    .sort((a, b) => LISTED.indexOf(a.category) - LISTED.indexOf(b.category) || a.pipelineId.localeCompare(b.pipelineId));
  return {
    schema: 'agentx.pipeline-task-diagnoses/v1',
    observedAt: now.toISOString(),
    authority: 'core.pipeline',
    authorization: 'not_granted',
    repair: 'none',
    scope: { lane: 'engineering', privateLanes: 'excluded', statuses: ACTIVE_STATUSES, scanned: scanned.length, scanLimit: MAX_SCAN, scanTruncated: tasks.length > MAX_SCAN },
    counts,
    escalations: diagnoses.filter(item => item.escalation).length,
    items: listed.slice(0, limit),
    truncated: listed.length > limit,
    consistency: 'Snapshot of several reads, not a transaction; any later mutation revalidates current state',
  };
}

module.exports = { readTaskDiagnosis, readStalledTaskDiagnoses, readEscalationPage, parseLimit, MAX_LIMIT };

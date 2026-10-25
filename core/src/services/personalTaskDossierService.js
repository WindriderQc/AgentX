'use strict';

const Dossier = require('../../models/PersonalTaskDossier');
const { collect, fingerprint, digest } = require('./personalTaskDossierSources');
const { commitLaneTask } = require('./pipelineLaneTaskMutationService');
const { reviewReason } = require('./personalTaskReview');
const { publicTask } = require('./personalTaskView');
const bad = (message, code = 'PERSONAL_DOSSIER_INVALID', status = 400) => Object.assign(new Error(message), { status, code });
const tasks = () => require('./personalTaskService');
const text = (value, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || required && !value.trim()) throw bad('Review text is missing or too long.');
  return value.trim();
};
const list = (value, max = 12) => {
  if (!Array.isArray(value) || value.length > max) throw bad('Use a bounded list.');
  return value;
};

function normalizeProposal(input, snapshot) {
  const states = ['active', 'waiting', 'resolved', 'cancelled', 'superseded', 'uncertain'];
  const actions = ['keep', 'update', 'complete', 'cancel'];
  if (!states.includes(input.state) || !actions.includes(input.action)) throw bad('Choose an explicit dossier state and proposed action.');
  const citations = list(input.citations).map(citation => {
    const source = snapshot.sources.find(source => source.id === citation.sourceId);
    const quote = text(citation.quote, 600);
    if (!source || !source.text.includes(quote)) throw bad('Cite an exact passage from the saved source.', 'PERSONAL_DOSSIER_EVIDENCE_REQUIRED');
    return { sourceId: source.id, quote, date: source.date, url: source.url, direction: source.direction, relation: source.relation };
  });
  const supported = citations.some(cite => Number.isFinite(Date.parse(cite.date)) && !['draft', 'unknown'].includes(cite.direction)
    && !['quoted', 'unknown'].includes(cite.relation) && !snapshot.sources.find(source => source.id === cite.sourceId).truncated);
  if (input.state !== 'uncertain' && !supported) throw bad('A dated source outside drafts and quotations is required.', 'PERSONAL_DOSSIER_EVIDENCE_REQUIRED');
  const remainingWork = list(input.remainingWork || []).map(value => text(value, 500));
  const uncertainties = list(input.uncertainties || []).map(value => text(value, 500));
  const closed = ['complete', 'cancel'].includes(input.action);
  if (closed && (remainingWork.length || uncertainties.length || input.state === 'uncertain' || input.state === 'waiting'
      || Object.values(snapshot.coverage).some(state => state !== 'read') || snapshot.gaps.length)) throw bad('Remaining work or incomplete source coverage prevents a closure proposal.', 'PERSONAL_DOSSIER_INCOMPLETE');
  if (closed && !['resolved', 'cancelled', 'superseded'].includes(input.state)) throw bad('Closure needs resolution, cancellation or supersession evidence.');
  if (input.state === 'uncertain' && input.action !== 'keep') throw bad('An uncertain dossier can only remain open for clarification.');
  const proposal = { state: input.state, action: input.action, summary: text(input.summary, 1200),
    actor: text(input.actor || '', 300, input.state !== 'uncertain'), citations, remainingWork, uncertainties,
    // Scheduling decision, appointment and remaining preparation are separate.
    schedulingDecision: input.schedulingDecision ? text(input.schedulingDecision, 500) : '',
    appointment: input.appointment ? text(input.appointment, 500) : '' };
  if (input.action === 'update') {
    const title = text(input.title, 200);
    if (['assistant', 'platform'].includes(reviewReason({ title }))) throw bad('This is not a personal owner action.');
    if (!Object.hasOwn(input, 'dueAt')) throw bad('Choose the action deadline explicitly, including null.');
    proposal.title = title;
    proposal.dueAt = tasks().parseDueAt(input.dueAt)?.toISOString() || null;
  }
  if (input.state !== 'uncertain' && /^(?:owner|propriétaire|unknown|inconnu)$/i.test(proposal.actor)) throw bad('Attribute the commitment to an identified actor.');
  return proposal;
}

async function get(id) {
  if (!/^[a-f0-9]{24}$/.test(id || '')) throw bad('Unknown dossier.');
  const row = await Dossier.findById(id).lean();
  if (!row) throw bad('Unknown dossier.', 'PERSONAL_DOSSIER_NOT_FOUND', 404);
  const task = await tasks().resolvePersonalTask(row.taskId);
  const decision = (task.personalDossierDecisions || []).find(receipt => receipt.dossierId === id);
  return { id, ...row.snapshot, proposal: row.proposal, proposalHash: row.proposalHash,
    proposalSchema: require('./personalTaskDossierTool').DOSSIER_TOOL.inputSchema.properties.proposal,
    decision: decision || null,
    stale: !decision && (task.__v || 0) !== row.taskRevision };
}

async function read(input, deps) {
  if (!/^\d{1,4}$/.test(String(input.ref || ''))) throw bad('Use the exact numeric personal task ID.');
  const task = await tasks().resolvePersonalTask(input.ref, { openOnly: true });
  const snapshot = await collect(input, task, deps);
  if (await Dossier.countDocuments({ taskId: task.pipelineId }) >= 100) throw bad('This task has 100 review receipts; review its history before adding another.', 'PERSONAL_DOSSIER_FULL', 409);
  const row = await Dossier.create({ taskId: task.pipelineId, taskRevision: task.__v || 0, snapshot, fingerprint: fingerprint(snapshot) });
  return get(String(row._id));
}

async function propose(input) {
  const current = await get(input.id);
  if (current.stale || current.decision) throw bad('Read the current dossier again.', 'PERSONAL_DOSSIER_CONFLICT', 409);
  if (current.task.personalReview.state !== 'accepted') throw bad('Use the source evidence in the existing extraction review before proposing a lifecycle change.', 'SECRETARY_REVIEW_REQUIRED', 409);
  const proposal = normalizeProposal(input, current);
  const proposalHash = digest(proposal);
  const row = await Dossier.findOneAndUpdate({ _id: input.id, proposal: null },
    { $set: { proposal, proposalHash } }, { new: true });
  if (!row) {
    if ((await get(input.id)).proposalHash !== proposalHash) throw bad('This review already has a different proposal.', 'PERSONAL_DOSSIER_CONFLICT', 409);
  }
  return get(input.id);
}

// Human decision path only. Native model tools may read/propose, never apply.
async function decide(input, deps) {
  const current = await get(input.id);
  if (!current.proposal || input.proposalHash !== current.proposalHash || !['apply', 'dismiss'].includes(input.decision)) throw bad('Choose the displayed proposal and its exact fingerprint.');
  if (current.decision) {
    if (input.decision !== current.decision.decision) throw bad('This proposal already has another decision.', 'PERSONAL_DOSSIER_CONFLICT', 409);
    return { replayed: true, task: publicTask(await tasks().resolvePersonalTask(current.task.id)), receipt: current.decision };
  }
  if (current.stale || input.revision !== current.task.revision) throw bad('The task or proposal changed; review it again.', 'PERSONAL_DOSSIER_CONFLICT', 409);
  const task = await tasks().resolvePersonalTask(current.task.id, { openOnly: true });
  const row = await Dossier.findById(input.id).lean();
  if ((task.__v || 0) !== row.taskRevision) throw bad('The task changed; read the dossier again.', 'PERSONAL_DOSSIER_CONFLICT', 409);
  if (input.decision === 'apply') {
    const fresh = await collect(current.selection, task, deps);
    if (fingerprint(fresh) !== row.fingerprint) throw bad('Sources or tasks changed; read the dossier again.', 'PERSONAL_DOSSIER_SOURCES_CHANGED', 409);
  }
  const proposal = row.proposal;
  const fields = {};
  if (input.decision === 'apply') {
    if (proposal.action === 'update') { fields.title = proposal.title; fields.dueAt = proposal.dueAt ? new Date(proposal.dueAt) : null; }
    if (task.personalRepeat && proposal.action !== 'keep') throw bad('Review repeating occurrences through their existing completion flow.', 'PERSONAL_DOSSIER_REPEATING', 409);
    if (proposal.action === 'complete') fields.status = 'done';
    if (proposal.action === 'cancel') fields.status = 'cancelled';
    if (fields.status) { fields.assignee = null; fields.heartbeatAt = null; }
  }
  const receipts = task.personalDossierDecisions || [];
  if (receipts.length >= 100) throw bad('The task review history is full.', 'PERSONAL_DOSSIER_FULL', 409);
  const receipt = { dossierId: input.id, proposalHash: row.proposalHash, decision: input.decision, action: proposal.action, at: new Date() };
  fields.personalDossierDecisions = [...receipts.map(value => value.toObject ? value.toObject() : value), receipt];
  const updated = await commitLaneTask(task, { fields, channel: 'personal_surface', kind: 'personal_dossier_decision',
    declaredActor: 'household-dad-desk', reason: proposal.summary,
    feedback: { by: 'household-dad-desk', text: `Dossier ${input.id}: ${input.decision} ${proposal.action}. Previous action: ${task.title}; deadline: ${task.dueAt?.toISOString() || 'none'}. ${proposal.summary}` } });
  return { replayed: false, task: publicTask(updated), receipt };
}

async function summaries(tasks) {
  if (!tasks.length) return tasks;
  tasks = await require('./personalTaskEvidenceSignalService').summaries(tasks);
  const rows = await Dossier.find({ taskId: { $in: tasks.map(task => task.id) }, proposal: { $ne: null } })
    .select('taskId taskRevision proposal proposalHash snapshot.observedAt snapshot.coverage snapshot.selection snapshot.gaps')
    .sort({ createdAt: -1 }).lean();
  return tasks.map(task => {
    const row = rows.find(row => row.taskId === task.id && row.taskRevision === task.revision);
    const history = task.lastDossierDecision && rows.find(row => String(row._id) === task.lastDossierDecision.dossierId
      && row.proposalHash === task.lastDossierDecision.proposalHash);
    const summary = row => ({ id: String(row._id), proposalHash: row.proposalHash, ...row.proposal,
      observedAt: row.snapshot.observedAt, coverage: row.snapshot.coverage, selection: row.snapshot.selection, gaps: row.snapshot.gaps });
    return { ...task, ...(row ? { dossierReview: summary(row) } : {}),
      ...(history ? { dossierHistory: { ...summary(history), decision: task.lastDossierDecision } } : {}) };
  });
}

async function operate(input, deps) {
  if (input.action === 'read') return read(input, deps);
  if (input.action === 'get') return get(input.id);
  if (input.action === 'propose') return propose({ ...input.proposal, id: input.id });
  throw bad('Use read, get or propose.');
}

module.exports = { operate, read, get, propose, decide, summaries, normalizeProposal };

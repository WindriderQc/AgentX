'use strict';

// Nestor proposes corrections to moments of the owner's history; the owner
// accepts or refuses them in Life Atlas. A proposal changes nothing by itself.
// Accepting applies it through the native edit (context timeline, or the kept
// souvenir), fenced by the revision Nestor saw, so a moment edited since then
// is never overwritten: the proposal becomes stale instead.

const { createHash } = require('node:crypto');
const Proposal = require('../../models/HistoryProposal');

const ID = /^[a-f0-9]{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = value => {
  if (!DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const PENDING_LIMIT = 300;
// What Nestor may propose. Sources, quotes, relations and decisions are never his.
const CONTEXT_FIELDS = ['title', 'description', 'date', 'precision', 'endDate', 'endPrecision', 'ongoing', 'category', 'place', 'notes'];
const SOUVENIR_FIELDS = ['eventDate', 'people', 'places', 'text'];
const failure = (message, statusCode = 400, code = 'HISTORY_PROPOSAL_INVALID') => Object.assign(new Error(message), { statusCode, code });
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const text = (value, max, name, required = false) => {
  if (value === undefined || value === null || value === '') { if (required) throw failure(`${name} is required`); return ''; }
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw failure(`${name} must be text of at most ${max} characters`);
  if (required && !value.trim()) throw failure(`${name} is required`);
  return value.trim();
};

function createHistoryProposals({ history = require('./personalHistoryService'), context = require('./personalHistoryContextService'),
  contract = require('./personalHistoryContextContract'), notes = () => require('./memoryNoteService').personal(),
  env = process.env } = {}) {

  const link = id => {
    const path = `/atlas/#entry:${id}`;
    try { return env.CORE_PUBLIC_URL ? new URL(path, env.CORE_PUBLIC_URL).href : path; } catch { return path; }
  };

  // A moment as Nestor and the inbox see it: what can be proposed and against which revision.
  function view(entry) {
    const tl = entry.timeline, s = entry.souvenir;
    const target = entry.souvenirNoteId ? 'souvenir' : tl ? 'context' : null;
    return { id: entry.id, link: link(entry.id), kept: Boolean(entry.souvenirNoteId), target,
      title: tl?.title || String(entry.text || '').slice(0, 160), description: s?.text || tl?.description || entry.text,
      date: s?.eventDate ?? (tl ? tl.date : entry.eventDate), precision: s?.eventDatePrecision ?? (tl ? tl.precision : entry.eventDatePrecision),
      endDate: tl?.endDate || null, place: tl?.place || (entry.places || []).join(', '), category: tl?.category || null,
      people: s?.people || entry.people || [], notes: tl?.notes || '',
      revision: target === 'souvenir' ? s?.revision ?? null : target === 'context' ? entry.contextRevision : null,
      reviewState: entry.reviewState, sourceDate: entry.sourceDate };
  }

  async function load(id) {
    if (!ID.test(String(id || ''))) throw failure('Choose an existing moment by its id', 404, 'HISTORY_MOMENT_UNKNOWN');
    const { entry } = await context.get(id);
    if (entry.reviewState === 'forgotten') throw failure('This moment is unavailable', 404, 'HISTORY_MOMENT_UNKNOWN');
    if (entry.souvenirNoteId && !entry.souvenir) {
      const [note] = await notes().souvenirs([entry.souvenirNoteId]);
      if (note) entry.souvenir = note;
    }
    return entry;
  }

  // Nestor finds moments by words (text, people, places), newest decisions untouched.
  async function search({ query, limit } = {}) {
    const clean = text(query, 300, 'query', true);
    const max = Math.max(1, Math.min(10, Math.trunc(Number(limit)) || 5));
    const { entries, total } = await history.list({ query: clean, limit: max });
    return { authority: 'agentx.core', query: clean, total, moments: entries.map(view) };
  }

  async function moment(id) { return { authority: 'agentx.core', moment: view(await load(id)) }; }

  function contextChanges(entry, input) {
    const patch = {};
    for (const [key, value] of Object.entries(input)) {
      if (!CONTEXT_FIELDS.includes(key)) throw failure(`${key} cannot be proposed for this moment (allowed: ${CONTEXT_FIELDS.join(', ')})`);
      patch[key] = value;
    }
    // The same normalization the owner's edit applies, so an accepted proposal never fails on shape.
    let normalized;
    try { normalized = contract.timeline({ ...entry.timeline, ...patch }); } catch (error) { throw failure(error.message); }
    const changes = Object.fromEntries(Object.keys(patch).map(key => [key, normalized[key]]));
    // Changing a date clears its uncertainty windows explicitly, as the owner's edit requires.
    if ('date' in changes || 'precision' in changes) { if (entry.timeline.dateWindow) changes.dateWindow = null; if (entry.timeline.ageStartWindow) changes.ageStartWindow = null; }
    if ('endDate' in changes || 'endPrecision' in changes) { if (entry.timeline.ageEndWindow) changes.ageEndWindow = null; }
    return changes;
  }

  function souvenirChanges(input) {
    const changes = {};
    for (const [key, value] of Object.entries(input)) {
      if (!SOUVENIR_FIELDS.includes(key)) throw failure(`${key} cannot be proposed for a kept souvenir (allowed: ${SOUVENIR_FIELDS.join(', ')})`);
      if (key === 'eventDate') { if (value !== '' && !(typeof value === 'string' && realDay(value))) throw failure('eventDate is YYYY-MM-DD, or empty for unknown'); changes.eventDate = value; }
      else if (key === 'text') changes.text = text(value, 4000, 'text', true);
      else {
        if (!Array.isArray(value) || value.length > 20 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 120)) throw failure(`${key} is a list of at most 20 names`);
        changes[key] = [...new Set(value.map(v => v.trim()))];
      }
    }
    return changes;
  }

  async function propose(input = {}) {
    const entry = await load(input.entryId);
    const current = view(entry);
    if (!current.target) throw failure('This moment has no context to correct yet; ask the owner to keep it or open it in Life Atlas', 409, 'HISTORY_MOMENT_NOT_EDITABLE');
    if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) || !Object.keys(input.changes).length) throw failure('changes is required');
    const changes = current.target === 'context' ? contextChanges(entry, input.changes) : souvenirChanges(input.changes);
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, current.target === 'context'
      ? entry.timeline[key] ?? null : key === 'eventDate' ? entry.souvenir?.eventDate ?? '' : entry.souvenir?.[key] ?? null]));
    if (canonical(before) === canonical(changes)) throw failure('The proposal changes nothing: the moment already says this', 409, 'HISTORY_PROPOSAL_UNCHANGED');
    const rationale = text(input.rationale, 2000, 'rationale', true);
    const evidence = (Array.isArray(input.evidence) ? input.evidence : []).slice(0, 5).map(item => ({
      quote: text(item?.quote, 500, 'evidence.quote', true), source: text(item?.source, 300, 'evidence.source') }));
    const key = digest(canonical({ entryId: entry.id, target: current.target, baseRevision: current.revision, changes }));
    const existing = await Proposal.findOne({ key }).lean();
    if (existing) return { authority: 'agentx.core', created: false, proposal: project(existing) };
    if (await Proposal.countDocuments({ scope: 'owner', state: 'pending' }) >= PENDING_LIMIT) throw failure('Too many proposals wait for the owner; let them review first', 429, 'HISTORY_PROPOSALS_FULL');
    const row = await Proposal.create({ key, entryId: entry.id, target: current.target, souvenirNoteId: entry.souvenirNoteId || '',
      baseRevision: current.revision, title: current.title.slice(0, 500), before, changes, rationale, evidence,
      conversationRef: text(input.conversationRef, 200, 'conversationRef') });
    return { authority: 'agentx.core', created: true, proposal: project(row.toObject()) };
  }

  function project(row) {
    return { id: String(row._id), entryId: row.entryId, link: link(row.entryId), target: row.target, title: row.title,
      baseRevision: row.baseRevision, before: row.before, changes: row.changes, rationale: row.rationale, evidence: row.evidence || [],
      proposedBy: row.proposedBy, state: row.state, decision: row.decision?.at ? row.decision : null, createdAt: row.createdAt };
  }

  async function list({ state = 'pending', limit } = {}) {
    if (!['pending', 'accepted', 'refused', 'stale', 'all'].includes(state)) throw failure('Choose pending, accepted, refused, stale or all');
    const filter = { scope: 'owner', ...(state === 'all' ? {} : { state }) };
    const max = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 100));
    const [rows, pending] = await Promise.all([Proposal.find(filter).sort({ createdAt: -1 }).limit(max).lean(),
      Proposal.countDocuments({ scope: 'owner', state: 'pending' })]);
    return { authority: 'agentx.core', pending, proposals: rows.map(project) };
  }

  // The owner accepts: apply through the native edit at the revision Nestor saw.
  async function accept(id, input = {}) {
    if (!ID.test(String(id || ''))) throw failure('Choose an existing proposal', 404, 'HISTORY_PROPOSAL_UNKNOWN');
    const row = await Proposal.findOneAndUpdate({ _id: id, scope: 'owner', state: 'pending' }, { $set: { state: 'applying' } }, { new: true }).lean();
    if (!row) throw failure('This proposal is no longer waiting for a decision', 409, 'HISTORY_PROPOSAL_DECIDED');
    const reason = text(input.reason, 2000, 'reason');
    try {
      let entry, appliedRevision;
      if (row.target === 'context') {
        ({ entry } = await context.edit(row.entryId, { revision: row.baseRevision, changes: { timeline: row.changes } }));
        appliedRevision = entry.contextRevision;
      } else {
        const body = { revision: row.baseRevision, ...row.changes };
        if ('eventDate' in row.changes) body.eventDatePrecision = row.changes.eventDate ? 'day' : 'unknown';
        const souvenir = await notes().editSouvenir(row.souvenirNoteId, body);
        appliedRevision = souvenir.revision;
        entry = (await load(row.entryId));
      }
      const done = await Proposal.findOneAndUpdate({ _id: id, state: 'applying' },
        { $set: { state: 'accepted', decision: { reason, at: new Date(), appliedRevision } } }, { new: true }).lean();
      return { authority: 'agentx.core', proposal: project(done), moment: view(entry) };
    } catch (error) {
      const stale = error.statusCode === 409;
      await Proposal.updateOne({ _id: id, state: 'applying' }, { $set: stale
        ? { state: 'stale', decision: { reason: 'The moment changed after this proposal', at: new Date(), appliedRevision: null } }
        : { state: 'pending' } });
      if (stale) throw failure('The moment changed since Nestor proposed this; the proposal is now stale', 409, 'HISTORY_PROPOSAL_STALE');
      throw error;
    }
  }

  async function refuse(id, input = {}) {
    if (!ID.test(String(id || ''))) throw failure('Choose an existing proposal', 404, 'HISTORY_PROPOSAL_UNKNOWN');
    const row = await Proposal.findOneAndUpdate({ _id: id, scope: 'owner', state: 'pending' },
      { $set: { state: 'refused', decision: { reason: text(input.reason, 2000, 'reason'), at: new Date(), appliedRevision: null } } }, { new: true }).lean();
    if (!row) throw failure('This proposal is no longer waiting for a decision', 409, 'HISTORY_PROPOSAL_DECIDED');
    return { authority: 'agentx.core', proposal: project(row) };
  }

  // The Nestor contract: read moments and propose; never accept, refuse or edit.
  async function operateForNestor(input = {}) {
    const operation = input.operation;
    if (operation === 'search') return search(input);
    if (operation === 'get') return moment(input.entryId);
    if (operation === 'propose') return propose(input);
    if (operation === 'status') {
      const rows = await Proposal.find({ scope: 'owner', proposedBy: 'nestor' }).sort({ createdAt: -1 }).limit(10).lean();
      return { authority: 'agentx.core', proposals: rows.map(project) };
    }
    throw failure('Choose search, get, propose or status');
  }

  return { search, moment, propose, list, accept, refuse, operateForNestor, CONTEXT_FIELDS, SOUVENIR_FIELDS };
}

module.exports = { createHistoryProposals };

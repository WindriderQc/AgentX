'use strict';

// Nestor proposes corrections to moments of the owner's history; the owner
// accepts or refuses them in Life Atlas. A proposal changes nothing by itself.
// Accepting applies it through the native edit (context timeline, or the kept
// souvenir), fenced by the revision Nestor saw, so a moment edited since then
// is never overwritten: the proposal becomes stale instead.
//
// A moment read from mail without a context, and a moment that is not in the
// history yet, are corrected or added from the owner's own words: Nestor must
// quote them, and on acceptance they become the moment's testimony source.

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
    const target = entry.souvenirNoteId ? 'souvenir' : tl ? 'context' : entry.kind === 'action' ? null : 'native';
    return { id: entry.id, link: link(entry.id), kept: Boolean(entry.souvenirNoteId), target,
      title: tl?.title || String(entry.text || '').slice(0, 160), description: s?.text || tl?.description || entry.text,
      date: s?.eventDate ?? (tl ? tl.date : entry.eventDate), precision: s?.eventDatePrecision ?? (tl ? tl.precision : entry.eventDatePrecision),
      endDate: tl?.endDate || null, place: tl?.place || (entry.places || []).join(', '), category: tl?.category || null,
      people: s?.people || entry.people || [], notes: tl?.notes || '',
      revision: target === 'souvenir' ? s?.revision ?? null : target === 'context' ? entry.contextRevision : target === 'native' ? entry.revision : null,
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

  // The timeline a native moment starts from: what its mail assertion already says.
  function nativeTimeline(entry) {
    const precision = ['day', 'instant'].includes(entry.eventDatePrecision) ? entry.eventDatePrecision : 'unknown';
    return contract.timeline({ legacyId: `native-${entry.id}`, title: String(entry.text || 'Moment').replace(/\s+/g, ' ').slice(0, 200),
      description: String(entry.text || ''), date: precision === 'unknown' ? null : String(entry.eventDate).slice(0, 10), precision: precision === 'unknown' ? 'unknown' : 'day',
      place: (entry.places || []).join(', ') || undefined, sourceIds: [], claimsWithExactQuotes: [] });
  }

  function contextChanges(entry, input, base = entry.timeline) {
    const patch = {};
    for (const [key, value] of Object.entries(input)) {
      if (!CONTEXT_FIELDS.includes(key)) throw failure(`${key} cannot be proposed for this moment (allowed: ${CONTEXT_FIELDS.join(', ')})`);
      patch[key] = value;
    }
    // The same normalization the owner's edit applies, so an accepted proposal never fails on shape.
    let normalized;
    try { normalized = contract.timeline({ ...base, ...patch }); } catch (error) { throw failure(error.message); }
    const changes = Object.fromEntries(Object.keys(patch).map(key => [key, normalized[key]]));
    // Changing a date clears its uncertainty windows explicitly, as the owner's edit requires.
    if ('date' in changes || 'precision' in changes) { if (base.dateWindow) changes.dateWindow = null; if (base.ageStartWindow) changes.ageStartWindow = null; }
    if ('endDate' in changes || 'endPrecision' in changes) { if (base.ageEndWindow) changes.ageEndWindow = null; }
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
    if (!current.target) throw failure('An action is resolved, not corrected as a life moment', 409, 'HISTORY_MOMENT_NOT_EDITABLE');
    if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) || !Object.keys(input.changes).length) throw failure('changes is required');
    const base = current.target === 'native' ? nativeTimeline(entry) : entry.timeline;
    const changes = current.target === 'souvenir' ? souvenirChanges(input.changes) : contextChanges(entry, input.changes, base);
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, current.target === 'souvenir'
      ? key === 'eventDate' ? entry.souvenir?.eventDate ?? '' : entry.souvenir?.[key] ?? null : base[key] ?? null]));
    if (canonical(before) === canonical(changes)) throw failure('The proposal changes nothing: the moment already says this', 409, 'HISTORY_PROPOSAL_UNCHANGED');
    const rationale = text(input.rationale, 2000, 'rationale', true);
    const evidence = quotes(input.evidence);
    if (current.target === 'native' && !evidence.length) throw failure('A moment read from mail is corrected from the owner\'s own words: quote them in evidence');
    const key = digest(canonical({ entryId: entry.id, target: current.target, baseRevision: current.revision, changes }));
    const existing = await Proposal.findOne({ key }).lean();
    if (existing) return { authority: 'agentx.core', created: false, proposal: project(existing) };
    await room();
    const row = await Proposal.create({ key, entryId: entry.id, target: current.target, souvenirNoteId: entry.souvenirNoteId || '',
      baseRevision: current.revision, title: current.title.slice(0, 500), before, changes, rationale, evidence,
      conversationRef: text(input.conversationRef, 200, 'conversationRef') });
    return { authority: 'agentx.core', created: true, proposal: project(row.toObject()) };
  }

  function project(row) {
    return { id: String(row._id), entryId: row.entryId || row.decision?.createdEntryId || '', link: row.entryId || row.decision?.createdEntryId ? link(row.entryId || row.decision.createdEntryId) : null,
      target: row.target, title: row.title, moment: row.moment || null,
      baseRevision: row.baseRevision, before: row.before, changes: row.changes, rationale: row.rationale, evidence: row.evidence || [],
      proposedBy: row.proposedBy, state: row.state, decision: row.decision?.at ? row.decision : null, createdAt: row.createdAt };
  }

  function quotes(value) {
    return (Array.isArray(value) ? value : []).slice(0, 5).map(item => ({
      quote: text(item?.quote, 500, 'evidence.quote', true), source: text(item?.source, 300, 'evidence.source') }));
  }
  const pendingCount = () => Proposal.countDocuments({ scope: 'owner', state: 'pending' });
  const inboxLink = () => { try { return env.CORE_PUBLIC_URL ? new URL('/atlas/#proposals', env.CORE_PUBLIC_URL).href : '/atlas/#proposals'; } catch { return '/atlas/#proposals'; } };
  async function room() {
    if (await pendingCount() >= PENDING_LIMIT) throw failure('Too many proposals wait for the owner; let them review first', 429, 'HISTORY_PROPOSALS_FULL');
  }

  // The owner's words, as a testimony source record the context can quote.
  function testimony(row) {
    const body = row.evidence.map(item => item.quote).join('\n');
    const id = `owner-words-${String(row._id)}`;
    return { id, body, record: { id, kind: 'testimony', subject: 'Précisé à Nestor', body, bodySha256: digest(body),
      date: new Date(row.createdAt).toISOString(), authority: 'direct-owner-statement',
      provenance: { proposalId: String(row._id), conversationRef: row.conversationRef || null } } };
  }

  // A moment read from mail gets a context from the owner's words, then the change as an owner edit.
  async function seedAndEdit(row) {
    const entry = await load(row.entryId);
    if (entry.timeline || entry.souvenirNoteId || entry.revision !== row.baseRevision) throw Object.assign(new Error('changed'), { statusCode: 409 });
    const words = testimony(row);
    const base = nativeTimeline(entry);
    await context.importBatch({ entries: [{ entryId: entry.id, sourceKey: entry.sourceKey, expectedContextRevision: 0,
      importId: `nestor-proposal:${String(row._id)}`,
      timeline: { ...base, sourceIds: [words.id], claimsWithExactQuotes: [{ sourceId: words.id, quote: row.evidence[0].quote }], confirmationBasis: 'owner-testimony' },
      sourceRecords: [words.record], relations: [], media: [] }] });
    return context.edit(entry.id, { revision: 1, changes: { timeline: row.changes } });
  }

  // A new moment the owner told Nestor: a candidate whose source is the owner's words.
  async function createMoment(row) {
    const words = testimony(row), m = row.moment;
    const [result] = (await context.importBatch({ entries: [{ expectedContextRevision: 0, importId: `nestor-proposal:${String(row._id)}`,
      entry: { kind: 'fact', text: m.description || m.title, sourceDate: new Date(row.createdAt).toISOString(),
        people: m.people || [], places: m.place ? [m.place] : [],
        source: { system: 'testimony', id: words.id, sourceSha256: digest(words.body), findingId: digest(`nestor-proposal:${String(row._id)}`) } },
      timeline: { legacyId: `nestor-${String(row._id)}`, title: m.title, description: m.description || undefined, category: m.category,
        date: m.date, precision: m.precision, endDate: m.endDate, endPrecision: m.endPrecision, ongoing: m.ongoing, place: m.place || undefined,
        sourceIds: [words.id], claimsWithExactQuotes: [{ sourceId: words.id, quote: row.evidence[0].quote }], confirmationBasis: 'owner-testimony' },
      sourceRecords: [words.record], relations: [], media: [] }] })).results;
    return { entry: result.entry };
  }

  // Nestor proposes a moment that is not in the history yet.
  async function proposeMoment(input = {}) {
    const raw = input.moment;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('moment is required: title, date with precision, and what happened');
    const allowed = ['title', 'description', 'date', 'precision', 'endDate', 'endPrecision', 'ongoing', 'category', 'place', 'people'];
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw failure(`moment.${key} is not supported (allowed: ${allowed.join(', ')})`);
    let normalized;
    try {
      normalized = contract.timeline({ legacyId: 'proposed', title: raw.title, description: raw.description, date: raw.date, precision: raw.precision,
        endDate: raw.endDate, endPrecision: raw.endPrecision, ongoing: raw.ongoing, category: raw.category, place: raw.place,
        sourceIds: [], claimsWithExactQuotes: [] });
    } catch (error) { throw failure(error.message); }
    const people = raw.people === undefined ? [] : raw.people;
    if (!Array.isArray(people) || people.length > 20 || people.some(v => typeof v !== 'string' || !v.trim() || v.length > 120)) throw failure('moment.people is a list of at most 20 names');
    const moment = Object.fromEntries(Object.entries({ title: normalized.title, description: normalized.description, date: normalized.date,
      precision: normalized.precision, endDate: normalized.endDate, endPrecision: normalized.endDate ? normalized.endPrecision : undefined,
      ongoing: normalized.ongoing || undefined, category: normalized.category, place: normalized.place, people: [...new Set(people.map(v => v.trim()))] })
      .filter(([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)));
    const rationale = text(input.rationale, 2000, 'rationale', true);
    const evidence = quotes(input.evidence);
    if (!evidence.length) throw failure('A new moment comes from the owner\'s own words: quote them in evidence');
    const key = digest(canonical({ target: 'new', moment, evidence: evidence.map(item => item.quote) }));
    const existing = await Proposal.findOne({ key }).lean();
    if (existing) return { authority: 'agentx.core', created: false, proposal: project(existing) };
    await room();
    const row = await Proposal.create({ key, target: 'new', baseRevision: 0, title: moment.title.slice(0, 500), moment, before: {}, changes: moment,
      rationale, evidence, conversationRef: text(input.conversationRef, 200, 'conversationRef') });
    return { authority: 'agentx.core', created: true, proposal: project(row.toObject()) };
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
      if (row.target === 'new') {
        ({ entry } = await createMoment(row));
        appliedRevision = entry.contextRevision;
      } else if (row.target === 'native') {
        ({ entry } = await seedAndEdit(row));
        appliedRevision = entry.contextRevision;
      } else if (row.target === 'context') {
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
        { $set: { state: 'accepted', ...(row.target === 'new' ? { entryId: entry.id } : {}),
          decision: { reason, at: new Date(), appliedRevision, createdEntryId: row.target === 'new' ? entry.id : '' } } }, { new: true }).lean();
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
    if (operation === 'add') return proposeMoment(input);
    if (operation === 'status') {
      const rows = await Proposal.find({ scope: 'owner', proposedBy: 'nestor' }).sort({ createdAt: -1 }).limit(10).lean();
      return { authority: 'agentx.core', pending: await pendingCount(), inbox: inboxLink(), proposals: rows.map(project) };
    }
    throw failure('Choose search, get, propose, add or status');
  }

  return { search, moment, propose, proposeMoment, list, accept, refuse, operateForNestor, pendingCount, CONTEXT_FIELDS, SOUVENIR_FIELDS };
}

module.exports = { createHistoryProposals };

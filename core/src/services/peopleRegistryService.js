'use strict';

const { createHash } = require('node:crypto');
const Person = require('../../models/PersonContact');
const Observation = require('../../models/PersonObservation');
const Proposal = require('../../models/PersonMergeProposal');
const { sealText } = require('./identifierVault');

// The owner's people registry. Imports record observations from preserved
// sources; a person is found again by an exact e-mail or phone. Two people that
// share one are proposed for merging; a shared full name is only a suggestion.
// Nothing merges until the owner accepts, and an accepted merge can be undone.
const SOURCES = ['gmail-header', 'gmail-vcf', 'outlook-vcf'];
const ROLES = ['from', 'to', 'cc', 'vcard'];
const DIRECTIONS = ['received', 'sent', 'draft', 'unknown'];
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{24}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'PEOPLE_REGISTRY_INVALID' });
const text = (value, maximum) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) throw failure(`Text exceeds ${maximum} characters or is invalid`);
  return value.trim();
};
const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

function email(value) {
  const clean = text(value, 320).toLowerCase();
  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw failure('An e-mail address is invalid');
  return clean;
}

// North American numbers lose their country prefix so the same line matches.
function phone(value) {
  let digits = text(value, 60).replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length >= 7 && digits.length <= 15 ? digits : '';
}

function date(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw failure('An ISO timestamp with timezone is required');
  }
  return new Date(value);
}

function normalize(input = {}) {
  const source = SOURCES.includes(input.source) ? input.source : null;
  const role = ROLES.includes(input.role) ? input.role : null;
  if (!source || !role || (source === 'gmail-header') === (role === 'vcard')) throw failure('Choose a source and a matching role');
  const ref = input.ref || {};
  const value = {
    source, role, name: text(input.name, 300), email: email(input.email),
    phones: [...new Set((Array.isArray(input.phones) ? input.phones : []).slice(0, 10).map(phone).filter(Boolean))],
    organization: text(input.organization, 300), note: text(input.note, 2000), occurredAt: date(input.occurredAt),
    direction: DIRECTIONS.includes(input.direction) ? input.direction : 'unknown',
    ref: { threadId: text(ref.threadId, 256), messageId: text(ref.messageId, 256),
      sourceSha256: text(ref.sourceSha256, 64), assertionId: text(ref.assertionId, 64) }
  };
  if (!value.email && !value.phones.length && !value.name) throw failure('An observation needs a name, an e-mail or a phone');
  if (!HASH.test(value.ref.sourceSha256)) throw failure('ref.sourceSha256 must be a SHA-256');
  if (source === 'gmail-header' && !value.ref.messageId) throw failure('A mail header needs its message id');
  if (source !== 'gmail-header' && !HASH.test(value.ref.assertionId)) throw failure('A contact card needs its assertion id');
  value.key = digest(JSON.stringify([source, role, value.ref, value.email, value.name, value.phones]));
  return value;
}

function project(person) {
  return { id: String(person._id), state: person.state, mergedInto: person.mergedInto || '',
    displayName: person.displayName, names: person.names, emails: person.emails, phones: person.phones,
    organizations: person.organizations, exchanges: person.exchanges, firstSeen: person.firstSeen,
    lastSeen: person.lastSeen, revision: person.revision };
}

const ranked = values => [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);

// Every visible field comes from the person's observations.
async function recompute(personId) {
  const rows = await Observation.find({ scope: 'owner', personId }).lean();
  const names = new Map(), emails = new Map(), phones = new Map(), organizations = new Map();
  const bump = (map, key) => key && map.set(key, (map.get(key) || 0) + 1);
  let exchanges = 0, firstSeen = null, lastSeen = null;
  for (const row of rows) {
    bump(names, row.name); bump(emails, row.email); bump(organizations, row.organization);
    row.phones.forEach(value => bump(phones, value));
    if (row.source === 'gmail-header') {
      exchanges += 1;
      if (row.occurredAt && (!firstSeen || row.occurredAt < firstSeen)) firstSeen = row.occurredAt;
      if (row.occurredAt && (!lastSeen || row.occurredAt > lastSeen)) lastSeen = row.occurredAt;
    }
  }
  const nameList = ranked(names).slice(0, 20), emailList = ranked(emails).slice(0, 20);
  const set = { names: nameList, foldedNames: [...new Set(nameList.map(fold).filter(Boolean))], emails: emailList,
    phones: ranked(phones).slice(0, 10), organizations: ranked(organizations).slice(0, 10), exchanges, firstSeen, lastSeen,
    displayName: nameList[0] || emailList[0] || ranked(phones)[0] || '' };
  return Person.findOneAndUpdate({ _id: personId, scope: 'owner' }, { $set: set, $inc: { revision: 1 } }, { new: true }).lean();
}

async function propose(a, b, reason, evidence = '') {
  if (!a || !b || a === b) return null;
  const [first, second] = [a, b].sort();
  const key = digest(['merge', first, second, reason].join('\n'));
  return Proposal.findOneAndUpdate({ key, scope: 'owner' },
    { $setOnInsert: { key, scope: 'owner', a: first, b: second, reason, evidence: String(evidence).slice(0, 320) } },
    { new: true, upsert: true }).lean();
}

// A full name of two words or more suggests, never proves, the same person.
async function suggestSameName(person) {
  for (const name of person.foldedNames.filter(value => value.split(' ').length >= 2)) {
    const others = await Person.find({ scope: 'owner', state: 'active', foldedNames: name, _id: { $ne: person._id } }, { _id: 1 }).limit(10).lean();
    for (const other of others) await propose(String(person._id), String(other._id), 'same-name', name);
  }
}

async function observe(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 200) throw failure('Record 1-200 observations');
  const values = inputs.map(normalize);
  const touched = new Set();
  let created = 0, replayed = 0, proposals = 0;
  for (const value of values) {
    if (await Observation.exists({ key: value.key })) { replayed += 1; continue; }
    const identifiers = [...(value.email ? [{ emails: value.email }] : []), ...value.phones.map(p => ({ phones: p }))];
    const matches = identifiers.length
      ? await Person.find({ scope: 'owner', state: 'active', $or: identifiers }).sort({ createdAt: 1, _id: 1 }).lean() : [];
    const fresh = !matches.length;
    const personId = fresh ? String((await Person.create({ scope: 'owner' }))._id) : String(matches[0]._id);
    for (const other of matches.slice(1)) {
      const shared = other.emails.includes(value.email) ? ['shared-email', value.email] : ['shared-phone', value.phones.find(p => other.phones.includes(p))];
      if (await propose(personId, String(other._id), ...shared)) proposals += 1;
    }
    value.note = (await sealText(value.note, { seenIn: 'people-registry' })).text;
    try {
      await Observation.create({ ...value, scope: 'owner', personId });
      // Later observations in the same batch find this person by the same identifiers.
      await Person.updateOne({ _id: personId, scope: 'owner' }, { $addToSet: {
        ...(value.email ? { emails: value.email } : {}), phones: { $each: value.phones } } });
      created += 1;
    } catch (error) {
      if (error.code !== 11000) throw error;
      // A concurrent import recorded it first: drop the empty person made for it.
      if (fresh) await Person.deleteOne({ _id: personId, scope: 'owner' });
      replayed += 1;
      continue;
    }
    touched.add(personId);
  }
  for (const id of touched) {
    const person = await recompute(id);
    if (person) await suggestSameName(person);
  }
  return { authority: 'agentx.core', created, replayed, people: touched.size, proposals };
}

async function list(input = {}) {
  const filter = { scope: 'owner', state: 'active' };
  if (input.query) {
    const escaped = text(input.query, 200).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = ['names', 'emails', 'organizations'].map(field => ({ [field]: { $regex: escaped, $options: 'i' } }));
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit)) || 30));
  const offset = Math.max(0, Math.trunc(Number(input.offset)) || 0);
  const [rows, total] = await Promise.all([
    Person.find(filter).sort({ exchanges: -1, _id: 1 }).skip(offset).limit(limit).lean(), Person.countDocuments(filter)]);
  return { authority: 'agentx.core', people: rows.map(project), total,
    nextOffset: offset + rows.length < total ? offset + rows.length : null };
}

// A person with the exchanges and contact cards that name them, and the owner
// souvenirs whose people include one of their names.
async function show(id) {
  if (!ID.test(id)) throw failure('Choose an existing person');
  const person = await Person.findOne({ _id: id, scope: 'owner' }).lean();
  if (!person) throw failure('Person is unavailable', 404);
  const [exchanges, cards] = await Promise.all([
    Observation.find({ scope: 'owner', personId: id, source: 'gmail-header' }).sort({ occurredAt: -1, _id: 1 }).limit(50).lean(),
    Observation.find({ scope: 'owner', personId: id, source: { $ne: 'gmail-header' } }).limit(20).lean()]);
  const MemoryNote = require('../../models/MemoryNote');
  const souvenirs = person.names.length ? await MemoryNote.find({ scope: 'owner', kind: 'souvenir', status: 'active',
    people: { $in: person.names } }).sort({ eventDate: 1 }).limit(50).lean() : [];
  return { authority: 'agentx.core', person: project(person),
    exchanges: exchanges.map(row => ({ id: String(row._id), role: row.role, direction: row.direction, occurredAt: row.occurredAt,
      name: row.name, email: row.email, ref: row.ref,
      archiveUrl: `/api/secretary/archive/${encodeURIComponent(row.ref.messageId)}?sha256=${row.ref.sourceSha256}` })),
    cards: cards.map(row => ({ id: String(row._id), source: row.source, name: row.name, email: row.email, phones: row.phones,
      organization: row.organization, note: row.note })),
    souvenirs: souvenirs.map(note => ({ id: String(note._id), text: note.text, eventDate: note.eventDate || '', people: note.people || [] })) };
}

async function proposals(input = {}) {
  const state = ['proposed', 'accepted', 'dismissed', 'undone'].includes(input.state) ? input.state : 'proposed';
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit)) || 30));
  const rows = await Proposal.find({ scope: 'owner', state: state === 'proposed' ? { $in: ['proposed', 'undone'] } : state })
    .sort({ reason: 1, createdAt: 1, _id: 1 }).limit(limit * 3).lean();
  const ids = [...new Set(rows.flatMap(row => [row.a, row.b]))];
  const people = new Map((await Person.find({ _id: { $in: ids }, scope: 'owner' }).lean()).map(p => [String(p._id), p]));
  const open = row => people.get(row.a)?.state === 'active' && people.get(row.b)?.state === 'active';
  const shown = rows.filter(row => state !== 'proposed' || open(row)).slice(0, limit);
  return { authority: 'agentx.core', proposals: shown.map(row => ({ id: String(row._id), reason: row.reason, evidence: row.evidence,
    state: row.state, revision: row.revision, decidedAt: row.decidedAt,
    a: people.has(row.a) ? project(people.get(row.a)) : null, b: people.has(row.b) ? project(people.get(row.b)) : null })) };
}

async function decide(id, input, from, to, change) {
  if (!ID.test(id)) throw failure('Choose an existing proposal');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw failure('The current proposal revision is required');
  const row = await Proposal.findOne({ _id: id, scope: 'owner' }).lean();
  if (!row) throw failure('Proposal is unavailable', 404);
  if (row.revision !== input.revision || !from.includes(row.state)) throw failure('Proposal changed; reload before deciding', 409);
  const extra = await change(row);
  const saved = await Proposal.findOneAndUpdate({ _id: id, scope: 'owner', revision: input.revision, state: row.state },
    { $set: { state: to, decidedAt: new Date(), ...(extra || {}) }, $inc: { revision: 1 } }, { new: true }).lean();
  if (!saved) throw failure('Proposal changed; reload before deciding', 409);
  return { authority: 'agentx.core', proposal: { id, state: saved.state, revision: saved.revision } };
}

async function accept(id, input = {}) {
  return decide(id, input, ['proposed', 'undone'], 'accepted', async row => {
    const people = await Person.find({ _id: { $in: [row.a, row.b] }, scope: 'owner', state: 'active' }).lean();
    if (people.length !== 2) throw failure('Both people must still be separate to merge them', 409);
    // The person seen first keeps the identity; the other is folded into it.
    const [keep, fold] = people.sort((x, y) => x.createdAt - y.createdAt || String(x._id).localeCompare(String(y._id)));
    const moved = (await Observation.find({ scope: 'owner', personId: String(fold._id) }, { _id: 1 }).lean()).map(o => String(o._id));
    const merged = await Person.findOneAndUpdate({ _id: fold._id, scope: 'owner', state: 'active', revision: fold.revision },
      { $set: { state: 'merged', mergedInto: String(keep._id) }, $inc: { revision: 1 } });
    if (!merged) throw failure('Person changed; reload before deciding', 409);
    await Observation.updateMany({ _id: { $in: moved }, scope: 'owner' }, { $set: { personId: String(keep._id) } });
    await recompute(String(keep._id)); await recompute(String(fold._id));
    return { moved, a: String(keep._id), b: String(fold._id) };
  });
}

async function dismiss(id, input = {}) {
  return decide(id, input, ['proposed', 'undone'], 'dismissed', async () => ({ moved: [] }));
}

async function undo(id, input = {}) {
  return decide(id, input, ['accepted'], 'undone', async row => {
    const keep = await Person.findOne({ _id: row.a, scope: 'owner', state: 'active' }).lean();
    const folded = await Person.findOne({ _id: row.b, scope: 'owner', state: 'merged', mergedInto: row.a }).lean();
    if (!keep || !folded) throw failure('This merge was built on by a later one; undo that first', 409);
    await Observation.updateMany({ _id: { $in: row.moved }, scope: 'owner', personId: row.a }, { $set: { personId: row.b } });
    await Person.updateOne({ _id: row.b, scope: 'owner' }, { $set: { state: 'active', mergedInto: '' } });
    await recompute(row.a); await recompute(row.b);
    return { moved: [] };
  });
}

module.exports = { normalize, observe, list, show, proposals, accept, dismiss, undo, fold, phone };

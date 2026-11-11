'use strict';

// One way for every collaborator of the owner's main agent to share what it
// knows: a standing brief. Each collaborator keeps its own records in Core
// (the Secretary's mail journal, the accountant's ledger); the main agent
// reads the same envelope for all of them and consults the collaborator only
// when the brief is not enough.
//
// A brief is read-only and computed from Core's records at the time of the
// call. A section Core cannot read is marked unavailable; the others still
// answer. Adding a collaborator means adding one entry to BRIEFS.

const DAY_MS = 24 * 60 * 60 * 1000;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, code: 'TEAM_BRIEF_INVALID' });

// Integer cents the Quebec way, beside every "<name>Cents" field, so no model adds or converts amounts.
function formatCents(cents) {
  if (!Number.isSafeInteger(cents)) return null;
  const abs = Math.abs(cents);
  const dollars = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${cents < 0 ? '-' : ''}${dollars},${String(abs % 100).padStart(2, '0')} $`;
}
function withDisplay(value) {
  if (Array.isArray(value)) return value.map(withDisplay);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = withDisplay(item);
    if (key.endsWith('Cents') && Number.isSafeInteger(item)) out[`${key.slice(0, -5)}Display`] = formatCents(item);
  }
  return out;
}

// What the Secretary flagged for the owner: one action per mail thread, written by her triage.
const emailActions = {
  async recent({ since, now, limit: requestedLimit = 20, offset = 0 }) {
    const limit = Math.max(1, Math.min(50, Math.trunc(Number(requestedLimit)) || 20));
    const collection = require('mongoose').connection.collection('emailactions');
    const filter = { $or: [{ createdAt: { $gte: since } }, { dueAt: { $gte: now } }] };
    const [rows, total] = await Promise.all([
      collection.find(filter).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit)
        .project({ _id: 0, gmailThreadId: 1, category: 1, action: 1, subject: 1, sender: 1, dueAt: 1, createdAt: 1 }).toArray(),
      collection.countDocuments(filter)
    ]);
    return { actions: rows.map(({ gmailThreadId, ...row }) => ({ threadId: gmailThreadId, ...row })), total,
      truncated: offset + rows.length < total,
      pagination: { limit, offset, returned: rows.length, hasMore: offset + rows.length < total,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
        consistency: 'live', order: ['createdAt:desc', '_id:desc'] } };
  }
};

function defaultSources() {
  return {
    emailActions,
    mailJournal: require('./mailJournalService'),
    financeQuery: require('./finance/financeQueryService'),
    financeAlerts: require('./finance/financeAlerts'),
    financePublication: require('./finance/financePublicationEvidence')
  };
}

const BRIEFS = Object.freeze({
  secretary: {
    title: 'Mail journal',
    covers: 'What the Secretary flagged for the owner (a reply, something urgent, a deadline), and dated digests of the mail threads she has processed, newest first. Mail of the last few minutes may be missing.',
    beyond: 'The exact text of a mail, the very latest message received, a draft, a reply, sorting or sending: consult the Secretary.',
    defaultDays: 2,
    sections: ({ sources, since, now, page }) => ({
      flaggedForOwner: () => sources.emailActions.recent({ since, now, ...page }),
      mail: () => sources.mailJournal.search({ since: since.toISOString(), limit: 20, ...page })
        .then(({ entries, total, truncated, pagination }) => ({ entries, total, truncated, ...(pagination && { pagination }) }))
    })
  },
  comptable: {
    title: 'Finance brief',
    covers: 'How far the ledger goes (freshness), latest closing balance per account with its date, in/out/net of the recent months without transfers between the owner\'s accounts, pending alerts and statements waiting for review.',
    beyond: 'A merchant, a category, a year, advice, the plan or a correction: consult the accountant.',
    defaultDays: 90,
    sections: ({ sources, since, now, page }) => ({
      // How far the ledger goes: a balance or a month is only as recent as the statements Core has read.
      freshness: async () => {
        const { rows = [] } = await sources.financeQuery.transactions({ limit: 1 });
        const latestTransactionDate = rows[0]?.date || null;
        const currentMonth = now.toISOString().slice(0, 7);
        const publication = sources.financePublication ? await sources.financePublication.read() : { status: 'unknown', lastAppliedAt: null };
        return { latestTransactionDate, currentMonth, publication,
          currentMonthHasData: Boolean(latestTransactionDate && latestTransactionDate.slice(0, 7) === currentMonth),
          note: 'Say this date with any figure. Each balance carries its own date. A month after latestTransactionDate has no data yet: say so instead of answering with another month.' };
      },
      balances: () => sources.financeQuery.balances({}),
      recentMonths: () => sources.financeQuery.monthly({ from: `${since.toISOString().slice(0, 7)}-01`, excludeCategory: 'Virements internes' }),
      pendingAlerts: () => sources.financeAlerts.list(page),
      statementsToReview: () => sources.financeQuery.statements({ status: 'needs_review', ...page })
    })
  }
});

const members = () => Object.keys(BRIEFS);

async function brief(input = {}, { sources = defaultSources(), now = () => new Date() } = {}) {
  const member = String(input.member || '').trim().toLowerCase();
  const definition = Object.hasOwn(BRIEFS, member) ? BRIEFS[member] : null;
  if (!definition) throw error(`Choose a collaborator: ${members().join(', ')}`);
  const days = input.days === undefined || input.days === null || input.days === '' ? definition.defaultDays : Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw error('days must be a whole number from 1 to 366');
  const page = {};
  if (input.limit !== undefined) {
    page.limit = Number(input.limit);
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 500) throw error('limit must be a whole number from 1 to 500');
  }
  if (input.offset !== undefined) {
    page.offset = Number(input.offset);
    if (!Number.isSafeInteger(page.offset) || page.offset < 0) throw error('offset must be a nonnegative safe integer');
  }
  if (input.asOf !== undefined && (typeof input.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.asOf))) throw error('asOf must be a UTC ISO date');
  const asOf = input.asOf === undefined ? now() : new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime()) || (input.asOf !== undefined && asOf.toISOString().slice(0, 19) !== input.asOf.slice(0, 19))) throw error('asOf must be a valid ISO date');
  const since = new Date(asOf.getTime() - days * DAY_MS);
  const sections = {};
  const readers = definition.sections({ sources, since, now: asOf, page });
  if (input.section !== undefined && !Object.hasOwn(readers, input.section)) throw error('Unknown brief section');
  const metadata = {};
  await Promise.all(Object.entries(readers).filter(([name]) => input.section === undefined || name === input.section).map(async ([name, read]) => {
    metadata[name] = { source: 'agentx.core.' + member + '.' + name, windowAsOf: asOf.toISOString(), freshness: { status: 'unknown', sourceUpdatedAt: null } };
    try { sections[name] = withDisplay(await read()); }
    catch { sections[name] = { unavailable: 'Source unavailable', code: 'SOURCE_UNAVAILABLE' }; }
  }));
  return { ok: true, authority: 'agentx.core', kind: 'team_brief', member, title: definition.title, asOf: asOf.toISOString(),
    since: since.toISOString(), covers: definition.covers, beyond: definition.beyond, sections, metadata };
}

module.exports = { brief, members, formatCents, withDisplay };

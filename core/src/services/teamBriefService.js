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

function defaultSources() {
  return {
    mailJournal: require('./mailJournalService'),
    financeQuery: require('./finance/financeQueryService'),
    financeAlerts: require('./finance/financeAlerts')
  };
}

const BRIEFS = Object.freeze({
  secretary: {
    title: 'Mail journal',
    covers: 'Dated digests of the mail threads the Secretary has processed, newest first. Promotional mail and the last few minutes may be missing.',
    beyond: 'The exact text of a mail, the very latest message received, a draft, a reply, sorting or sending: consult the Secretary.',
    defaultDays: 2,
    sections: ({ sources, since }) => ({
      mail: () => sources.mailJournal.search({ since: since.toISOString(), limit: 20 })
        .then(({ entries, total, truncated }) => ({ entries, total, truncated }))
    })
  },
  comptable: {
    title: 'Finance brief',
    covers: 'Latest closing balance per account with its date, in/out/net of the recent months without transfers between the owner\'s accounts, pending alerts and statements waiting for review.',
    beyond: 'A merchant, a category, a year, advice, the plan or a correction: consult the accountant.',
    defaultDays: 90,
    sections: ({ sources, since }) => ({
      balances: () => sources.financeQuery.balances({}),
      recentMonths: () => sources.financeQuery.monthly({ from: `${since.toISOString().slice(0, 7)}-01`, excludeCategory: 'Virements internes' }),
      pendingAlerts: () => sources.financeAlerts.list({}),
      statementsToReview: () => sources.financeQuery.statements({ status: 'needs_review' })
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
  const asOf = now();
  const since = new Date(asOf.getTime() - days * DAY_MS);
  const sections = {};
  await Promise.all(Object.entries(definition.sections({ sources, since })).map(async ([name, read]) => {
    try { sections[name] = withDisplay(await read()); }
    catch (cause) { sections[name] = { unavailable: String(cause?.message || 'unavailable').slice(0, 200) }; }
  }));
  return { ok: true, authority: 'agentx.core', kind: 'team_brief', member, title: definition.title, asOf: asOf.toISOString(),
    since: since.toISOString(), covers: definition.covers, beyond: definition.beyond, sections };
}

module.exports = { brief, members, formatCents, withDisplay };

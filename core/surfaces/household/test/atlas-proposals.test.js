'use strict';

// Life Atlas inbox of corrections Nestor proposed. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const load = () => import(path.join(__dirname, '..', 'public', 'atlas', 'proposals.js'));
const entryId = 'a'.repeat(24);
const proposal = { id: 'p1', entryId, target: 'context', title: 'Synthetic move', createdAt: '2026-10-29T12:00:00Z',
  before: { date: '2004', precision: 'year', place: null, ageStartWindow: { start: '2003-01-01', end: '2005-12-31' } },
  changes: { date: '2004-06-12', precision: 'day', place: 'Synthetic town', ageStartWindow: null },
  rationale: 'The owner said the move happened on June 12.', evidence: [{ quote: 'we moved on June 12', source: 'conversation' }], state: 'pending' };

test('values read as the owner would say them', async () => {
  const { show } = await load();
  assert.equal(show('precision', 'year'), 'année');
  assert.equal(show('category', 'home'), 'Lieux & maison');
  assert.equal(show('people', ['A', 'B']), 'A, B');
  assert.equal(show('place', null), '—');
  assert.equal(show('ongoing', true), 'oui');
  assert.equal(show('ageStartWindow', { start: '2003-01-01', end: '2005-12-31' }), '2003-01-01 → 2005-12-31');
});

test('a card shows today and the proposal side by side, escapes text, and the dossier banner names the proposal', async () => {
  const { ProposalInbox } = await load();
  const button = { hidden: true, innerHTML: '', setAttribute() {}, addEventListener() {} };
  const api = { state: { dataset: 'real', events: [{ id: `core-${entryId}`, title: 'Synthetic move <b>' }] } };
  const inbox = new ProposalInbox({}, api, button);
  inbox.items = [proposal];
  inbox.pending = 1;
  inbox.byEntry = new Map([[`core-${entryId}`, [proposal]]]);
  inbox.render();
  assert.equal(button.hidden, false);
  assert.match(button.innerHTML, /Nestor propose <span>1<\/span>/);
  const card = inbox.card(proposal);
  assert.match(card, /Synthetic move &lt;b&gt;/);
  assert.match(card, /<td>2004<\/td><td class="proposal-new">2004-06-12<\/td>/);
  assert.match(card, /<td>année<\/td><td class="proposal-new">jour<\/td>/);
  assert.match(card, /Repère d’âge/);
  assert.match(card, /we moved on June 12/);
  assert.match(inbox.banner({ id: `core-${entryId}` }), /Nestor propose une correction/);
  assert.equal(inbox.banner({ id: 'core-other' }), '');
  api.state.dataset = 'demo';
  inbox.render();
  assert.equal(button.hidden, true);
});

test('a new moment shows only what Nestor heard, and a moment from the sources says the words become its source', async () => {
  const { ProposalInbox } = await load();
  const button = { hidden: true, innerHTML: '', setAttribute() {}, addEventListener() {} };
  const inbox = new ProposalInbox({}, { state: { dataset: 'real', events: [] } }, button);
  const fresh = { id: 'p2', entryId: '', target: 'new', title: 'Synthetic canoe trip', createdAt: '2026-10-29T12:00:00Z', changes: {}, before: {},
    moment: { title: 'Synthetic canoe trip <i>', date: '1998-07', precision: 'month', place: 'Synthetic lake', people: [], dateWindow: { start: '1998-07-01', end: '1998-07-31' } },
    rationale: 'Told in conversation.', evidence: [{ quote: 'in July 1998 we canoed' }], state: 'pending' };
  const card = inbox.card(fresh);
  assert.match(card, /NOUVEAU MOMENT/);
  assert.match(card, /Synthetic canoe trip &lt;i&gt;/);
  assert.doesNotMatch(card, /Aujourd’hui/);
  assert.match(card, /<th>Précision de la date<\/th><td class="proposal-new">mois<\/td>/);
  assert.doesNotMatch(card, /Personnes|Fenêtre de date|Ouvrir le moment/);
  assert.match(card, /Ajouter au Life Atlas/);
  const native = inbox.card({ ...proposal, id: 'p3', target: 'native' });
  assert.match(native, /MOMENT DE TES SOURCES/);
  assert.match(native, /Tes mots deviendront la source/);
});

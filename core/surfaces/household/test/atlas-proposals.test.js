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

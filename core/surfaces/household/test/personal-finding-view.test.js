'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../public/personal-finding-view');
const fixture = [
  { id: '0001', category: 'email', title: 'Check payment (if unpaid)', note: 'A colleague requested a receipt. Objet « Planning ». The reply is unverified.', sourceUrl: 'https://mail.google.com/mail/#all/syntheticA', dueAt: '2020-01-01', createdAt: '2026-10-01' },
  { id: '0002', category: 'email', title: 'Call the office (demande du 2 oct. 2026)', note: 'Correspondance à clarifier.', sourceUrl: 'https://mail.google.com/mail/#inbox/syntheticA.', createdAt: '2026-10-02' },
  { id: '0003', category: 'assistant', title: 'Continue reading', sourceUrl: 'https://mail.google.com/mail/#all/syntheticA' },
  { id: '0004', category: 'email', title: 'Check payment (if unpaid)', note: 'No linked source' },
  { id: '0005', category: 'email', title: 'Another request', sourceUrl: 'https://mail.google.com.evil.test/mail/#all/syntheticA' },
];

test('same-thread references group findings without merging source-less or differently sourced actions', () => {
  const before = structuredClone(fixture), groups = view.groupFindings(fixture);
  assert.equal(groups.length, 3);
  const group = groups.find(g => g.tasks.length === 2);
  assert.deepEqual(group.tasks.map(t => t.id), ['0002', '0001']);
  assert.equal(group.title, 'Planning');
  assert.equal(group.pastDates, 1);
  assert.equal(groups.reduce((sum, group) => sum + group.tasks.length, 0), 4);
  assert.deepEqual(fixture, before);
  assert.equal(view.groupFindings(fixture, { category: 'background' }).flatMap(g => g.tasks).length, 1);
  assert.equal(view.sourceSubject({ note: 'Ce fil laisse supposer que les actions du 4 mai sont terminées.' }), null);
  assert.equal(view.groupFindings(fixture, { category: '' }).find(g => g.key === group.key).tasks.length, 3);
});

test('search covers original notes, accents and every finding; evidence filters do not infer obligations', () => {
  assert.equal(view.groupFindings(fixture, { query: 'CORRESPONDANCE clarifier' })[0].tasks[0].id, '0002');
  assert.deepEqual(view.groupFindings(fixture, { quality: 'past-date' }).flatMap(g => g.tasks).map(t => t.id), ['0001']);
  assert.equal(view.groupFindings(fixture, { quality: 'missing-source' }).length, 2);
  assert.equal(view.flags({ dueAt: 'invalid' }).pastDate, false);
  assert.equal(view.mailSource('javascript:alert(1)'), null);
  assert.equal(view.mailSource('https://mail.google.com.evil.test/'), null);
});

test('readable wording retains conditions and exact original records remain available', () => {
  assert.equal(view.displayTitle(fixture[0]), 'Check payment (if unpaid)');
  assert.equal(view.displayTitle(fixture[1]), 'Call the office');
  assert.equal(view.displayTitle({ title: 'Verify the claim — demande du 2 oct. 2026' }), 'Verify the claim');
  const note = 'Secretary deep review / action synthetic:key. A correspondent requested a meeting; no agreement recorded. Source: https://mail.google.com/mail/#all/syntheticA';
  assert.match(view.contextExcerpt({ note }), /^A correspondent requested a meeting; no agreement recorded/);
  assert.match(note, /secretary|Secretary/);
});

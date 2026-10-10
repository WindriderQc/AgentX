'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../public/family-organizer'), 'utf8'), { window, Intl, Date });
const { matches, nextDay } = window.FamilyOrganizer;
const row = { title: 'Préparer le sac', note: 'Vérifier la règle', profileId: 'a', status: 'queued', dueAt: '2026-10-11T03:59:59.999Z', dueDay: '2026-10-10', dueToday: true, overdue: false };
test('family filters keep the selected child and accent-insensitive instructions together', () => {
  assert.equal(matches(row, { profile: 'a', query: 'REGLE' }), true);
  assert.equal(matches(row, { profile: 'b', query: 'REGLE' }), false);
  assert.equal(matches(row, { query: 'unknown' }), false);
  assert.equal(matches(row, { view: 'review' }), false);
  assert.equal(matches({ ...row, status: 'review' }, { view: 'review' }), true);
});
test('the seven-day view follows canonical household date keys rather than the browser offset', () => {
  assert.equal(matches(row, { view: 'week', today: '2026-10-10' }), true);
  assert.equal(matches({ ...row, dueDay: '2026-10-16' }, { view: 'week', today: '2026-10-10' }), true);
  assert.equal(matches({ ...row, dueDay: '2026-10-17' }, { view: 'week', today: '2026-10-10' }), false);
  assert.equal(matches({ ...row, dueDay: '2026-10-09' }, { view: 'week', today: '2026-10-10' }), false);
  assert.equal(nextDay('2026-12-31', 1), '2027-01-01');
  assert.equal(nextDay('2026-03-08', 1), '2026-03-09');
});
test('today includes overdue work and undated routines remain separately discoverable', () => {
  assert.equal(matches({ ...row, dueToday: false, overdue: true }, { view: 'today' }), true);
  assert.equal(matches({ ...row, dueToday: false, overdue: false }, { view: 'today' }), false);
  assert.equal(matches({ ...row, dueAt: null, dueDay: null }, { view: 'undated' }), true);
  assert.equal(matches(row, { view: 'undated' }), false);
});

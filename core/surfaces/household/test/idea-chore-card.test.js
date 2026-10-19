'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const window = {};
const context = { window, Intl, Date };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/family-frequency'), 'utf8'), context);
vm.runInNewContext(fs.readFileSync(require.resolve('../public/idea-chore-card'), 'utf8'), context);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const profiles = [{ id: 'synthetic-a', displayName: 'Synthetic A', avatar: '🌱' }, { id: 'synthetic-b', displayName: 'Synthetic B' }];
const idea = { id: 'idea-1', text: 'Proposed chore: Water <the> plant — Synthetic reason', createdAt: '2026-10-19T12:00:00Z',
  familyChore: { title: 'Water <the> plant', note: 'Dry soil only', profileId: 'synthetic-a', cadence: 'interval', intervalDays: 7, stars: 2 } };

test('a proposed chore shows the Kids Room preview, the reason and the parent choices, escaped', () => {
  const html = window.IdeaChoreCard.row(idea, profiles, esc);
  assert.match(html, /<output data-chore-preview>🌱 Water &lt;the&gt; plant · every 7 days · ★★<\/output>/);
  assert.match(html, /Synthetic reason/);
  assert.match(html, /<option value="synthetic-a" selected>Synthetic A<\/option>/);
  assert.match(html, /<option value="interval" selected>Every N days<\/option>/);
  assert.match(html, /<option selected>2<\/option>/);
  assert.match(html, /data-idea-action="family_chore">Create the chore</);
  assert.doesNotMatch(html, /<the>/);
});

test('without a suggested child the parent must choose one', () => {
  const html = window.IdeaChoreCard.row({ ...idea, familyChore: { ...idea.familyChore, profileId: null } }, profiles, esc);
  assert.match(html, /<option value="">Choose a child…<\/option><option value="synthetic-a">/);
  assert.match(html, /<output data-chore-preview>Water &lt;the&gt; plant/);
});

test('the parent choices become the promotion fields', () => {
  const elements = { profileId: { value: 'synthetic-b' }, cadence: { value: 'interval' }, stars: { value: '3' } };
  const fields = { intervalDays: { value: '10' }, winterIntervalDays: { value: '' } };
  const form = { elements, querySelector: selector => fields[/name="(\w+)"/.exec(selector)[1]] };
  const card = { querySelector: () => form };
  assert.deepEqual(JSON.parse(JSON.stringify(window.IdeaChoreCard.read(card))),
    { profileId: 'synthetic-b', cadence: 'interval', stars: 3, intervalDays: 10, winterIntervalDays: null });
  elements.cadence.value = 'weekly';
  assert.deepEqual(JSON.parse(JSON.stringify(window.IdeaChoreCard.read(card))), { profileId: 'synthetic-b', cadence: 'weekly', stars: 3 });
});

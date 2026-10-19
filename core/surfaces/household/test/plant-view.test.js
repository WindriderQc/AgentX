'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const window = {};
const context = { window, Intl, Date };
vm.runInNewContext(fs.readFileSync(require.resolve('../public/family-frequency'), 'utf8'), context);
vm.runInNewContext(fs.readFileSync(require.resolve('../public/plant-view'), 'utf8'), context);
const view = window.PlantView, frequency = window.FamilyFrequency;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const plain = value => JSON.parse(JSON.stringify(value));

test('candidates show confidence, preselect the most likely and warn when Nestor is unsure', () => {
  const html = view.candidatesHtml([{ commonName: 'Pothos <doré>', latinName: 'Epipremnum aureum', confidence: 0.86, traits: 'panachures' },
    { commonName: 'Philodendron', confidence: 0.09 }], esc);
  assert.match(html, /value="0" checked/); assert.match(html, /Pothos &lt;doré&gt;/); assert.match(html, /86 %/);
  assert.match(html, /class="strong" style="width:86%"/); assert.match(html, /class="weak" style="width:9%"/);
  assert.doesNotMatch(html, /Nestor is not sure/);
  assert.match(view.candidatesHtml([{ commonName: 'Maybe', confidence: 0.3 }], esc), /Nestor is not sure/);
  assert.match(view.candidatesHtml([], esc), /found no plant/);
});

test('a care action can only be assigned to a child old enough for it', () => {
  const profiles = [{ id: 'a', displayName: 'Little A', ageBand: 'little' }, { id: 'b', displayName: 'School B', ageBand: 'school' }];
  assert.equal(view.ageAllows(profiles[0], { minAgeBand: 'school' }), false);
  assert.equal(view.ageAllows(profiles[1], { minAgeBand: 'school' }), true);
  assert.equal(view.ageAllows(profiles[0], { minAgeBand: 'little' }), true);
  const html = view.actionHtml({ title: 'Arroser', cadence: 'interval', intervalDays: 7, stars: 2, minAgeBand: 'school', profileId: 'b' }, 0, profiles, esc, frequency);
  assert.doesNotMatch(html, /Little A/); assert.match(html, /<option value="b" selected>School B<\/option>/);
  assert.match(html, /<option value="interval" selected>/); assert.match(html, /<option value="2" selected>★★<\/option>/);
});

test('the child preview shows needs, the do-not-eat warning and the fun fact', () => {
  const html = view.childPreviewHtml({ nickname: 'Gérard', identification: { commonName: 'Pothos' },
    careSheet: { light: { text: 'Vive' }, soil: { text: 'Hidden from kids' } }, funFact: 'Il grimpe.',
    toxicity: { children: { level: 'none' }, cats: { level: 'toxic' }, dogs: { level: 'none' } } }, esc);
  assert.match(html, /Vive/); assert.doesNotMatch(html, /Hidden from kids/);
  assert.match(html, /Do not eat/); assert.match(html, /Il grimpe/);
  assert.doesNotMatch(view.childPreviewHtml({ nickname: 'Bob', toxicity: { children: { level: 'none' } } }, esc), /Do not eat/);
});

test('list rows link to the card and say what is missing on a draft', () => {
  const html = view.listRowHtml({ id: 'p1', nickname: 'Gérard', status: 'draft', problems: ['species', 'care_plan'], photos: [{ url: '/api/family/plants/p1/photos/x' }] }, esc);
  assert.match(html, /href="\/dad\/family\/plants\?plant=p1"/);
  assert.match(html, /Choose the species\./); assert.match(html, /src="\/api\/family\/plants\/p1\/photos\/x\?view=manage"/);
  assert.match(html, /pill waiting">Draft/);
  assert.deepEqual(plain(view.problemText(['toxicity_review'])), ['Confirm that you checked the toxicity.']);
});

test('the editor reads back into Core fields and keeps sources of unchanged text', () => {
  const field = (name, value, extra = {}) => ({ name, value, ...extra });
  const fields = {
    nickname: field('nickname', 'Gérard'), room: field('room', 'Salon'), spot: field('spot', ''), funFact: field('funFact', 'Il grimpe.'),
    'care-light': field('care-light', 'Vive'), 'care-water': field('care-water', 'Changed text'), 'care-soil': field('care-soil', ' '),
    'tox-children': field('tox-children', 'toxic'), 'tox-cats': field('tox-cats', 'toxic'), 'tox-dogs': field('tox-dogs', 'unknown'),
    'tox-reviewed': field('tox-reviewed', 'on', { checked: true })
  };
  const action = values => ({ querySelector: selector => ({ value: values[/name="(\w+)"/.exec(selector)[1]] }) });
  const form = {
    querySelector: selector => fields[/name="([\w-]+)"/.exec(selector)[1]] || null,
    querySelectorAll: () => [action({ title: 'Arroser', note: '', cadence: 'interval', intervalDays: '7', winterIntervalDays: '', stars: '2', minAgeBand: 'school', profileId: '' }),
      action({ title: '  ', note: '', cadence: 'weekly', stars: '1', minAgeBand: 'school', profileId: '' })]
  };
  const read = view.readEditor(form, frequency);
  assert.deepEqual(plain(read.careSheet), { light: { text: 'Vive' }, water: { text: 'Changed text' } });
  assert.deepEqual(plain(read.toxicity), { children: { level: 'toxic' }, cats: { level: 'toxic' }, dogs: { level: 'unknown' }, reviewed: true });
  assert.deepEqual(plain(read.carePlan), [{ title: 'Arroser', note: '', cadence: 'interval', stars: 2, minAgeBand: 'school', profileId: null, intervalDays: 7, winterIntervalDays: null }]);
  const kept = view.keepSources(read, { careSheet: { light: { text: 'Vive', sources: ['https://example.org/a'] }, water: { text: 'Old', sources: ['https://example.org/b'] } },
    toxicity: { children: { level: 'toxic', note: 'Irrite', sources: ['https://example.org/t'] }, cats: { level: 'mild', sources: ['https://example.org/c'] } } });
  assert.deepEqual(plain(kept.careSheet.light.sources), ['https://example.org/a']);
  assert.equal(kept.careSheet.water.sources, undefined);
  assert.deepEqual(plain(kept.toxicity.children), { level: 'toxic', note: 'Irrite', sources: ['https://example.org/t'] });
  assert.deepEqual(plain(kept.toxicity.cats), { level: 'toxic' });
});

test('a draft already applied to the card is not proposed again', () => {
  const draft = { careSheet: { light: { text: 'Vive' } }, carePlan: [{ title: 'Arroser' }] };
  assert.equal(view.draftApplied(draft, { careSheet: { light: { text: 'Vive', sources: [] } }, carePlan: [{ title: 'Arroser', stars: 2 }] }), true);
  assert.equal(view.draftApplied(draft, { careSheet: {}, carePlan: [] }), false);
  assert.equal(view.draftApplied(draft, { careSheet: { light: { text: 'Vive' } }, carePlan: [{ title: 'Arroser' }, { title: 'Tourner' }] }), false);
});

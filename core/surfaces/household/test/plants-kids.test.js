'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const window = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../public/plants-kids'), 'utf8'), { window, Intl, Date, URLSearchParams });
const jungle = window.KidsPlants;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const gerard = { id: 'p1', nickname: 'Gérard', commonName: 'Pothos doré', room: 'Salon', mood: 'thirsty', doNotEat: true,
  needs: { light: 'Lumière vive, sans soleil direct', water: 'Quand le dessus est sec.' }, funFact: 'Il grimpe aux arbres',
  photos: [{ id: 'x', url: '/api/family/plants/p1/photos/x' }],
  care: [{ ref: '0042', title: 'Arroser Gérard', profileId: 'leo', dueToday: true, overdue: false, waiting: false, dueDay: '2026-10-20' }] };
const bob = { id: 'p2', nickname: 'Bob', commonName: 'Cactus', mood: 'happy', doNotEat: false, needs: {}, photos: [],
  care: [{ ref: '0050', title: 'Tourner Bob', profileId: 'mia', dueToday: false, overdue: false, waiting: false, dueDay: '2026-10-27' }] };
const lili = { id: 'p3', nickname: 'Lili', mood: 'waiting', needs: {}, photos: [], care: [{ ref: '0060', title: 'Arroser Lili', profileId: 'leo', waiting: true }] };

test('the plants waiting on this child come first, then plants needing care', () => {
  assert.deepEqual([...jungle.ordered([bob, lili, gerard], 'leo')].map(plant => plant.nickname), ['Gérard', 'Lili', 'Bob']);
  assert.deepEqual([...jungle.ordered([bob, lili, gerard], 'mia')].map(plant => plant.nickname), ['Gérard', 'Lili', 'Bob']);
  assert.equal(jungle.dueFor(gerard, 'leo').ref, '0042');
  assert.equal(jungle.dueFor(gerard, 'mia'), null);
});

test('the introduction speaks only from the published card, in French', () => {
  assert.equal(jungle.introText(gerard, 'Léo'),
    'Salut Léo ! Moi, c’est Gérard. Mon nom de plante, c’est Pothos doré. Pour la lumière : Lumière vive, sans soleil direct. '
    + 'Pour l’eau : Quand le dessus est sec. Attention : on ne mange jamais mes feuilles, et les animaux non plus ! Le sais-tu ? Il grimpe aux arbres.');
  assert.equal(jungle.introText({ nickname: 'Bob', needs: {} }), 'Salut ! Moi, c’est Bob.');
});

test('the card binds the big button to this child’s due chore, and tells others what is next', () => {
  const mine = jungle.cardHtml(gerard, 'leo', esc);
  assert.match(mine, /data-jungle-check="0042">.*Done: Arroser Gérard!/s);
  assert.match(mine, /Never eat my leaves/); assert.match(mine, /I’m thirsty!/); assert.match(mine, /Nestor me présente Gérard/);
  assert.match(mine, /href="\/kids\?ask=Parle-moi%20de%20G%C3%A9rard%2C%20notre%20Pothos%20dor%C3%A9\."/);
  assert.doesNotMatch(jungle.cardHtml(gerard, 'mia', esc), /data-jungle-check/);
  assert.match(jungle.cardHtml(gerard, 'mia', esc), /Nothing to do for Gérard today/);
  assert.match(jungle.cardHtml(bob, 'mia', esc), /Next for you: Tourner Bob/);
  assert.match(jungle.cardHtml(lili, 'leo', esc), /Dad will check/);
  assert.doesNotMatch(jungle.cardHtml(bob, 'mia', esc), /Never eat/);
});

test('the gallery shows each mood and marks the plants waiting on this child', () => {
  const html = jungle.galleryHtml([bob, gerard], 'leo', esc);
  assert.match(html, /class="jungle-tile mood-thirsty mine"/); assert.match(html, /class="jungle-tile mood-happy"/);
  assert.match(html, /🌿/); assert.match(jungle.galleryHtml([], 'leo', esc), /No plant yet/);
});

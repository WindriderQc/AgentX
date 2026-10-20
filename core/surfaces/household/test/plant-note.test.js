'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { plantNote } = require('../../../src/domains/household/plantNote');
const { validateMarkdownText } = require('../../../../skills/obsidian-open-formats/scripts/validate');

const vault = path.join(__dirname, '../../../../config/obsidian-vault');
const plant = { id: '0123456789abcdef01234567', nickname: 'Gérard', room: 'Salon',
  identification: { commonName: 'Pothos doré', latinName: 'Epipremnum aureum' },
  careSheet: { light: { text: 'Vive, indirecte', sources: ['https://example.org/a'] }, water: { text: 'Quand c’est sec' }, mistakes: { text: 'Trop d’eau' } },
  toxicity: { children: { level: 'toxic', note: 'Irrite la bouche', sources: ['https://example.org/t'] }, cats: { level: 'toxic' }, dogs: { level: 'mild' }, reviewed: true },
  funFact: 'Il grimpe aux arbres.',
  carePlan: [{ key: 'arroser', title: 'Arroser Gérard', note: 'Un verre', cadence: 'interval', intervalDays: 7, winterIntervalDays: 14 },
    { key: 'tourner', title: 'Tourner le pot', cadence: 'weekly' }] };

test('a published card becomes a Plante note: typed properties, template sections and its sources', () => {
  const note = plantNote(plant);
  assert.equal(note.title, 'Plante — Gérard');
  assert.deepEqual(note.tags, ['plante']);
  assert.deepEqual({ ...note.properties }, { type: 'plante', source: 'agentx-plant', plant_id: '0123456789abcdef01234567', nom: 'Gérard',
    espece: 'Pothos doré', nom_latin: 'Epipremnum aureum', piece: 'Salon', lumiere: 'Vive, indirecte', arrosage_jours: 7, arrosage_hiver_jours: 14,
    toxicite_enfants: 'toxique', toxicite_chats: 'toxique', toxicite_chiens: 'légèrement toxique' });
  for (const heading of ['## Besoins', '## Entretien', '## Erreurs fréquentes', '## Toxicité', '## Sources', '## Le sais-tu ?']) assert.match(note.body, new RegExp(heading.replace('?', '\\?')));
  assert.match(note.body, /Enfants : toxique — Irrite la bouche/);
  assert.match(note.body, /- https:\/\/example\.org\/a\n- https:\/\/example\.org\/t/);
  assert.match(note.body, /- Arroser Gérard — Un verre/);
  assert.match(note.body, /La fiche AgentX reste la référence/);
  assert.deepEqual(validateMarkdownText(note.body), []);
  const empty = plantNote({ id: 'x', nickname: 'Bob', careSheet: {}, carePlan: [] });
  assert.equal(empty.properties.arrosage_jours, null); assert.equal(empty.properties.toxicite_enfants, 'inconnue');
});

test('the Plante template and the Plantes view use the same properties as the export', () => {
  const template = fs.readFileSync(path.join(vault, 'Templates/Plante.md'), 'utf8');
  assert.deepEqual(validateMarkdownText(template), []);
  const front = yaml.load(template.split('---')[1]);
  const exported = Object.keys(plantNote(plant).properties).filter(key => !['source', 'plant_id'].includes(key));
  assert.deepEqual(exported.filter(key => !(key in front)), []);
  const base = yaml.load(fs.readFileSync(path.join(vault, 'Maison.base'), 'utf8'));
  const view = base.views.find(entry => entry.name === 'Plantes');
  assert.deepEqual(view.filters, { and: ['type == "plante"'] });
  assert.deepEqual(view.order.filter(column => column.startsWith('note.')).map(column => column.slice(5)).filter(key => !(key in front)), []);
  assert.ok(base.views.some(entry => entry.name === 'Garanties'), 'existing views stay');
});

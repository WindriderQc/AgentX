'use strict';

// A published plant card as a vault note (#871), in the shape of
// Templates/Plante.md so Maison.base lists it under Plantes. Core stays the
// source of truth: the note says so, and an export never changes the card.

const LEVELS = Object.freeze({ unknown: 'inconnue', none: 'non toxique', mild: 'légèrement toxique', toxic: 'toxique' });
const SECTIONS = Object.freeze([
  ['Besoins', [['light', 'Lumière'], ['water', 'Eau'], ['humidity', 'Humidité']]],
  ['Entretien', [['soil', 'Terre'], ['repotting', 'Rempotage'], ['fertilizer', 'Engrais']]]
]);
const SUBJECTS = Object.freeze([['children', 'Enfants'], ['cats', 'Chats'], ['dogs', 'Chiens']]);

const line = text => String(text || '').replace(/\s+/g, ' ').trim();

/** The interval of the first watering action, in days, or empty. */
function wateringDays(plan = []) {
  const action = plan.find(entry => /arros|water|eau\b/i.test(`${entry.title} ${entry.key}`) && entry.cadence === 'interval');
  return { summer: action?.intervalDays ?? null, winter: action?.winterIntervalDays ?? null };
}

function plantNote(plant) {
  const sheet = plant.careSheet || {}, toxicity = plant.toxicity || {};
  const watering = wateringDays(plant.carePlan);
  const sources = [...new Set([
    ...Object.values(sheet).flatMap(entry => entry?.sources || []),
    ...SUBJECTS.flatMap(([key]) => toxicity[key]?.sources || [])
  ])];
  const body = [
    `# ${line(plant.nickname)}`,
    '',
    ...SECTIONS.flatMap(([heading, fields]) => [`## ${heading}`, ...fields.map(([key, label]) => `${label} : ${line(sheet[key]?.text)}`), '']),
    '## Erreurs fréquentes', line(sheet.mistakes?.text) || '—', '',
    '## Toxicité', ...SUBJECTS.map(([key, label]) => `${label} : ${LEVELS[toxicity[key]?.level || 'unknown']}${toxicity[key]?.note ? ` — ${line(toxicity[key].note)}` : ''}`), '',
    '## Soins dans la Kids Room', ...(plant.carePlan || []).map(action => `- ${line(action.title)}${action.note ? ` — ${line(action.note)}` : ''}`), '',
    '## Sources', ...(sources.length ? sources.map(url => `- ${url}`) : ['—']), '',
    '## Le sais-tu ?', line(plant.funFact) || '—', '',
    `_Fiche exportée d’AgentX (${plant.id}). La fiche AgentX reste la référence : une modification ici ne la change pas._`
  ].join('\n');
  return {
    title: `Plante — ${line(plant.nickname)}`,
    body,
    tags: ['plante'],
    properties: {
      type: 'plante', source: 'agentx-plant', plant_id: String(plant.id), nom: line(plant.nickname),
      espece: line(plant.identification?.commonName), nom_latin: line(plant.identification?.latinName),
      piece: line(plant.room), lumiere: line(sheet.light?.text),
      arrosage_jours: watering.summer, arrosage_hiver_jours: watering.winter,
      ...Object.fromEntries(SUBJECTS.map(([key]) => [`toxicite_${{ children: 'enfants', cats: 'chats', dogs: 'chiens' }[key]}`, LEVELS[toxicity[key]?.level || 'unknown']]))
    }
  };
}

module.exports = { plantNote };

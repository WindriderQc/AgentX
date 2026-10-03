'use strict';

// A small library of well-established techniques PsyX draws from instead of
// improvising one. Each card says when it fits and gives the steps as they are
// taught; PsyX adapts the wording to the person, never the method.

const TECHNIQUES = Object.freeze([
  {
    id: 'slow-breathing', name: 'Respiration lente', minutes: 3,
    when: 'Body is activated: anger rising, anxiety, racing heart, before a hard conversation.',
    steps: ['Inspire par le nez pendant 4 secondes.', 'Expire lentement par la bouche pendant 6 secondes, comme à travers une paille.', 'Continue 3 minutes, environ 6 respirations par minute.', 'Si la tête tourne, respire moins profond, pas plus vite.']
  },
  {
    id: 'grounding-54321', name: 'Ancrage 5-4-3-2-1', minutes: 3,
    when: 'Overwhelmed, panicky or stuck in the head; needs to come back to the present.',
    steps: ['Nomme 5 choses que tu vois.', 'Nomme 4 choses que tu peux toucher, et touche-les.', 'Nomme 3 sons que tu entends.', 'Nomme 2 odeurs.', 'Nomme 1 goût, ou une chose que tu apprécies en ce moment.']
  },
  {
    id: 'thought-record', name: 'Examen d’une pensée', minutes: 10,
    when: 'A harsh or catastrophic thought drives the emotion, and he is calm enough to look at it.',
    steps: ['La situation : quoi, quand, avec qui, en une phrase.', 'L’émotion et sa force de 0 à 100.', 'La pensée exacte qui t’a traversé.', 'Les faits qui l’appuient, puis les faits qui ne cadrent pas.', 'Une pensée plus juste, qui tient compte des deux.', 'L’émotion maintenant, de 0 à 100.']
  },
  {
    id: 'behavioural-activation', name: 'Une activité qui nourrit', minutes: 15,
    when: 'Low mood, withdrawal, waiting to feel like it before doing anything.',
    steps: ['Choisis une activité petite qui te donnait du plaisir ou un sentiment d’accomplissement.', 'Fixe le jour, l’heure et l’endroit; 15 minutes suffisent.', 'Fais-la même sans envie : l’action vient avant la motivation.', 'Note ton humeur de 0 à 10 avant et après.']
  },
  {
    id: 'worry-time', name: 'Rendez-vous avec les inquiétudes', minutes: 15,
    when: 'Worries come back all day or at bedtime and cannot be solved right now.',
    steps: ['Fixe 15 minutes par jour, même heure, même endroit, pas au lit ni dans l’heure avant le coucher.', 'Dans la journée, note l’inquiétude en une ligne et reporte-la au rendez-vous.', 'Au rendez-vous, relis la liste : ce qui a une action, décide du premier geste; le reste, laisse-le sur le papier.', 'Quand les 15 minutes finissent, ferme le carnet et passe à autre chose.']
  },
  {
    id: 'repair-with-child', name: 'Réparer avec un enfant', minutes: 5,
    when: 'He lost his temper with a child and wants to make it right.',
    steps: ['Attends d’être calme, puis mets-toi à sa hauteur.', 'Nomme ce que tu as fait, sans « mais » : « J’ai crié. Ce n’était pas correct. »', 'Dis que ce n’était pas sa faute, et sépare-le de la règle si elle tient toujours.', 'Demande-lui comment c’était pour lui, et écoute.', 'Dis ce que tu feras la prochaine fois que tu sentiras la colère monter.']
  }
]);

const HEADER = 'TECHNIQUES — established methods to draw from when one fits; never improvise a variant. Offer one, by its name, only when it fits what he brings';

// A frontier reply gets the full cards; a local one, with little room, gets
// their names and points to the steps the interface shows.
function techniquesSystemMessage({ full = false } = {}) {
  if (!full) return `${HEADER}. Do not recite steps from memory: name the technique and point him to its exact steps in his toolbox, under Expériences in the PsyX memory panel: ${TECHNIQUES.map(card => card.name).join('; ')}.`;
  return [`${HEADER}, and give the steps as written, in your own words.`,
    ...TECHNIQUES.map(card => `- ${card.name} (${card.minutes} min). When: ${card.when} Steps: ${card.steps.join(' ')}`)].join('\n');
}

module.exports = { TECHNIQUES, techniquesSystemMessage };

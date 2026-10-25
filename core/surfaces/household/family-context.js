'use strict';

// What a family conversation may know and keep beyond talking. Nestor sees a
// read-only summary of the Kids Room routines (#41) and may keep a child's idea
// or reminder for the parent to review (#13). Nothing here checks in, approves
// or completes a chore, and no personal task or code work is reachable.
const defaultIdeaInbox = require('../../src/services/ideaInboxService');
const { ageInYears, birthdayLabel, instanceToday } = require('../../src/domains/household/familyBirthDate');
const { issPasses: defaultIssPasses } = require('../../src/services/mcpIssTools');

const IDEA_REQUEST = /(j'?\s?ai une (?:super |bonne |petite )?id[ée]e|(?:note|garde|ajoute|[ée]cris)[sz]?(?:-moi)?\s+(?:une|mon|cette|l')\s*id[ée]e|id[ée]e pour (?:papa|la maison|plus tard)|i have an idea|(?:save|keep|write down) (?:my|this|an) idea)/i;
const REMINDER_REQUEST = /(rappelle[sz]?[- ]moi|fais[- ]moi penser|n'?oublie pas de me rappeler|(?:note|ajoute|garde)[sz]?(?:-moi)?\s+(?:un|ce)\s+rappel|remind me)/i;
const MAX_PROFILES = 8;
const MAX_CHORES = 5;
const MAX_CHARACTERS = 1500;

function familyCaptureKind(text) {
  const value = String(text || '');
  if (REMINDER_REQUEST.test(value)) return 'reminder';
  if (IDEA_REQUEST.test(value)) return 'idea';
  return null;
}

function choreLabel(chore) {
  const when = chore.overdue ? ' (en retard)' : chore.dueToday ? ' (aujourd’hui)' : '';
  return `${String(chore.title || '').slice(0, 80)}${when}`;
}

function profileLine(profile, room) {
  const available = (room.available || []).slice(0, MAX_CHORES).map(choreLabel);
  const waiting = (room.waiting || []).slice(0, MAX_CHORES).map(choreLabel);
  const parts = [available.length ? `à faire : ${available.join(', ')}` : 'rien à faire maintenant'];
  if (waiting.length) parts.push(`en attente de papa : ${waiting.join(', ')}`);
  if (room.completedToday) parts.push(`approuvées aujourd’hui : ${room.completedToday}`);
  return `- ${String(profile.displayName || profile.id).slice(0, 80)} : ${parts.join(' ; ')}.`;
}

// The same rows the Kids Room shows. A failure leaves the turn without the
// summary instead of failing it; Nestor then says it does not have the list.
async function choreSummary(familyTasks, { logger } = {}) {
  try {
    const { profiles = [] } = await familyTasks.listProfiles();
    if (!profiles.length) return '';
    const lines = [];
    for (const profile of profiles.slice(0, MAX_PROFILES)) {
      const { room } = await familyTasks.room({ profileId: profile.id });
      lines.push(profileLine(profile, room));
    }
    return ['Kids Room routines (read-only; the child checks in on the Kids Room page and Dad approves; you cannot check in, approve or change them):',
      ...lines].join('\n').slice(0, MAX_CHARACTERS);
  } catch (error) {
    logger?.warn?.('Family chore summary unavailable', { error: error.message });
    return '';
  }
}

const PLANT_MOODS = Object.freeze({ thirsty: 'a soif aujourd’hui', needs_care: 'a besoin d’un soin aujourd’hui', waiting: 'papa vérifie', happy: 'va bien' });
const MAX_PLANTS = 12;

// The published plant cards (#870), so Nestor talks about the family's plants
// from their cards and nothing else. A failure leaves the turn without them.
async function plantSummary(plants, { logger } = {}) {
  if (!plants) return '';
  try {
    const { plants: rows = [] } = await plants.list({ view: 'child' });
    if (!rows.length) return '';
    const lines = rows.slice(0, MAX_PLANTS).map(plant => {
      const facts = [plant.needs?.light && `lumière : ${plant.needs.light}`, plant.needs?.water && `eau : ${plant.needs.water}`,
        plant.doNotEat ? 'toxique : on ne mange jamais ses feuilles, les animaux non plus' : 'pas toxique', PLANT_MOODS[plant.mood]];
      const name = [plant.commonName, plant.room].filter(Boolean).join(', ');
      return `- ${String(plant.nickname).slice(0, 60)}${name ? ` (${name})` : ''} : ${facts.filter(Boolean).join(' ; ')}.`;
    });
    return ['Plantes de la maison (fiches publiées par papa ; parle de ces plantes seulement à partir de ces fiches ; si une question dépasse la fiche, propose de demander à papa ; tu ne peux pas cocher leurs soins) :',
      ...lines].join('\n').slice(0, MAX_CHARACTERS);
  } catch (error) {
    logger?.warn?.('Family plant summary unavailable', { error: error.message });
    return '';
  }
}

// ISS passes over the house, only when the child asks about the station and
// the instance enabled it (HOUSEHOLD_FAMILY_ISS_PASSES=true). The times come
// from Core's dated computation; without it Nestor must say it does not know.
const ISS_QUESTION = /(\bISS\b|station spatiale|space station)/i;
const MAX_ISS_LISTED = 3;

function familyIssEnabled(env = process.env) {
  return String(env.HOUSEHOLD_FAMILY_ISS_PASSES || '').trim().toLowerCase() === 'true';
}

function isIssQuestion(text) {
  return ISS_QUESTION.test(String(text || ''));
}

function visibleLine(pass) {
  const v = pass.visible;
  const minutes = Math.max(1, Math.round(v.durationSec / 60));
  return `${v.startLocal} → ${v.endLocal.replace(/^.*?(\d{2} h \d{2})$/, '$1')}, du ${v.start.direction} vers ${v.end.direction}, ${String(v.maxElDeg).replace('.', ',')}° de hauteur max, environ ${minutes} min`;
}

async function issSummary(userText, { readPasses = defaultIssPasses, logger } = {}) {
  if (!isIssQuestion(userText)) return '';
  try {
    const result = await readPasses({ hours: 72, visible_only: true, max_passes: MAX_ISS_LISTED });
    const visible = result.passes.filter(p => p.observable);
    const lines = [
      `Passages de la Station spatiale internationale au-dessus de la maison (calcul AgentX du ${result.computedAtLocal}, éléments orbitaux CelesTrak du ${result.tle.epochLocal}${result.tle.stale ? ', anciens : dis que l’heure peut être moins précise' : ''}). Cite ces jours et heures exactement, n’en invente aucune. La météo n’est pas connue : dis « si le ciel est dégagé ».`,
    ];
    if (visible.length) {
      lines.push(`Visibles à l’œil nu dans les 72 prochaines heures : ${visible.slice(0, MAX_ISS_LISTED).map(visibleLine).join(' ; ')}.`);
    } else {
      lines.push('Aucun passage visible à l’œil nu dans les 72 prochaines heures.');
    }
    const hidden = result.counts.geometric - result.counts.observable;
    if (hidden > 0) lines.push(`${hidden} autre(s) passage(s) au-dessus de l’horizon ne seront pas visibles (en plein jour, trop bas, ou ISS dans l’ombre de la Terre).`);
    if (result.view) lines.push(`Une vue 3D montre ces passages : propose-la avec <show kind="link" title="${result.view.label}">${result.view.url}</show>.`);
    return lines.join('\n').slice(0, MAX_CHARACTERS);
  } catch (error) {
    logger?.warn?.('Family ISS passes unavailable', { error: error.message });
    return 'Les passages de l’ISS sont indisponibles pour l’instant : dis-le simplement et ne donne aucune heure.';
  }
}

// How Nestor sounds with children (#121). Famille keeps the Nestor
// personality, whose adult temperament (a dry-witted majordomo) read flat to a
// child; this replaces that temperament in family conversations only. It is
// presentation: accuracy and every safety rule still come first.
const FAMILY_TONE = [
  'Tone with children: playful, curious and encouraging, like a fun guide at a science museum, never a dry or formal butler.',
  'This replaces the selected personality\'s adult temperament in family conversations.',
  'Answer first, in simple words. When it helps, add one vivid comparison, a surprising fact or a tiny game the child can try.',
  'Show real interest in the question instead of generic praise such as "Great question".',
  'When useful, offer a short invitation to explore further. A complete answer can end naturally; do not force a question after every reply.',
  'Gentle humour is welcome, never sarcasm and never at the child\'s expense.',
  'Stay within two to four short spoken sentences unless the child asks for more. Fun never overrides accuracy or the safety rules.'
].join(' ');

const AGE_LABELS = Object.freeze({ little: 'petite enfance', school: 'âge scolaire', teen: 'adolescence' });

// With a birth date the parent set, the age is computed for today and the
// birthday is given as day and month; otherwise the age band stands.
function memberAge(profile, today) {
  const age = ageInYears(profile.birthDate, today);
  if (age === null) return AGE_LABELS[profile.ageBand] || AGE_LABELS.school;
  return `${age} an${age > 1 ? 's' : ''}, anniversaire le ${birthdayLabel(profile.birthDate)}`;
}

// Who the children are comes from the parent's Family page, not from whatever
// notes a search happens to select (#119): notes about one child must never
// make Nestor forget another. A failure leaves the turn without the list.
// Super Dad only: Famille turns never call this.
async function householdMembers(familyTasks, { logger, now = new Date() } = {}) {
  try {
    const { profiles = [] } = await familyTasks.listProfileDetails();
    const today = instanceToday(now);
    const names = profiles.filter(profile => profile.active !== false).slice(0, MAX_PROFILES)
      .map(profile => `${String(profile.displayName || profile.id).slice(0, 80)} (${memberAge(profile, today)})`);
    return names.length
      ? `Enfants de la maison (profils de la page Famille de papa; cette liste fait foi sur les notes) : ${names.join(', ')}.`
      : '';
  } catch (error) {
    logger?.warn?.('Household members unavailable', { error: error.message });
    return '';
  }
}

// One explicit request per turn: an idea or reminder goes to the parent's
// inbox; otherwise an explicit "remember" keeps a family note as before.
async function familyTurn({ userText, notes, familyTasks, detectMemoryRequest, logger, ideaInbox = defaultIdeaInbox, withChores = true, plants = null, withIss = false, readIssPasses }) {
  const result = { savedNow: false, captured: null, chores: '', plants: '', iss: '' };
  const kind = familyCaptureKind(userText);
  if (kind) {
    try {
      await ideaInbox.captureIdea({ text: userText, origin: 'family', kind });
      result.captured = kind;
    } catch (error) {
      logger?.error?.('Family idea capture failed', { error: error.message });
      result.captured = 'failed';
    }
  } else if (detectMemoryRequest(userText)) {
    try {
      await notes.record({ topic: 'general', text: userText, type: 'fact' });
      result.savedNow = true;
    } catch (error) { logger?.error?.('Household memory save failed', { error: error.message }); }
  }
  if (withChores) {
    result.chores = await choreSummary(familyTasks, { logger });
    result.plants = await plantSummary(plants, { logger });
  }
  if (withIss) result.iss = await issSummary(userText, { logger, readPasses: readIssPasses });
  return result;
}

// Sentences Nestor may say only because the capture actually happened.
function capturedPrompt(captured) {
  if (captured === 'failed') return ' The child asked to keep an idea or reminder but it could not be saved; say so plainly and suggest telling Dad directly.';
  if (!captured) return '';
  return ` The child asked to keep ${captured === 'reminder' ? 'a reminder' : 'an idea'} and it has been saved for Dad to review; confirm plainly that Dad will see it, without promising that he will act on it.`;
}

module.exports = { FAMILY_TONE, capturedPrompt, choreSummary, familyCaptureKind, familyIssEnabled, familyTurn, householdMembers, isIssQuestion, issSummary, plantSummary };

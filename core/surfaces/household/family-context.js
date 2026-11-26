'use strict';

// What a family conversation may know and keep beyond talking. Nestor sees a
// read-only summary of the Kids Room routines (#41) and may keep a child's idea
// or reminder for the parent to review (#13). Nothing here checks in, approves
// or completes a chore, and no personal task or code work is reachable.
const defaultIdeaInbox = require('../../src/services/ideaInboxService');
const { ageInYears, birthdayLabel, instanceToday } = require('../../src/domains/household/familyBirthDate');

// Match the requested action at the start of the child's own words. Keep the
// original text for storage, including what follows "de ne pas oublier…".
const SPOKEN_OPENING = /^(?:(?:nestor|bonjour|salut|hey|euh|ben|svp|s'il (?:te|vous) pla[iî]t|please)[ ,]+)+/i;
const POLITE_REQUEST = /^(?:(?:je veux|je voudrais|j'aimerais) que tu|(?:est[- ]ce que )?(?:tu (?:peux|pourrais)(?:[- ]tu)?|vous (?:pouvez|pourriez))|(?:peux|pourrais)[- ]tu|(?:pouvez|pourriez)[- ]vous|(?:can|could|would) you)\s+/i;
const REQUEST_VERBS = new Map(Object.entries({
  'me rappeler': 'rappelle-moi', 'me rappelles': 'rappelle-moi', 'me faire penser': 'fais-moi penser',
  garder: 'garde', noter: 'note', écrire: 'écris', ajouter: 'ajoute', retenir: 'retiens', retiennes: 'retiens', prendre: 'prends'
}));
const IDEA_REQUESTS = [
  /^j[' ]?ai une (?:super |bonne |petite )?id[ée]e\b/i,
  /^(?:note[sz]?|garde[sz]?|ajoute[sz]?|[ée]cris)(?:[- ]moi)?\s+(?:(?:une|mon|cette)\s+|l')id[ée]e\b/i,
  /^id[ée]e pour (?:papa|la maison|plus tard)\b/i,
  /^(?:i have an idea|(?:save|keep|write down) (?:my|this|an) idea)\b/i
];
const REMIND_ME = /^(?:rappelle[sz]?[- ]moi|(?:n')?oublie pas de me rappeler)\s+/i;
const FRENCH_WHEN = /^(?:demain(?: matin| soir| après[- ]midi)?|tantôt|ce soir|dans [\p{L}\d-]+ (?:minutes?|heures?|jours?))\s+/iu;
const FRENCH_CLOCK = /^[àa] (?:midi|minuit|\d{1,2}(?::\d\d|\s*h(?:\s*\d{1,2})?)|[\p{L}\d-]+ heures?)\s+/iu;
const REMINDER_ACTION = /^(?:de\s+(?!(?:quoi|qui|quand|quel(?:le)?s?)\b)|d')\p{L}/iu;
const ENGLISH_WHEN = /^(?:tomorrow(?: morning| night| afternoon)?|tonight|in [\w-]+ (?:minutes?|hours?|days?))\s+/i;
const ENGLISH_CLOCK = /^at (?:noon|midnight|\d{1,2}(?::\d\d)?(?:\s*[ap]m)?)\s+/i;

const REMINDER_REQUESTS = [
  /^fais[- ]moi penser\s+(?:(?:[àa]|au|aux|de)\s+|d')\p{L}/iu,
  /^(?:note[sz]?|ajoute[sz]?|garde[sz]?)(?:[- ]moi)?\s+(?:un|ce)\s+rappel\b/i
];
function asksForReminder(request) {
  if (REMIND_ME.test(request)) {
    const action = request.replace(REMIND_ME, '').replace(FRENCH_WHEN, '').replace(FRENCH_CLOCK, '');
    return REMINDER_ACTION.test(action);
  }
  if (/^remind me\s+/i.test(request)) {
    const action = request.replace(/^remind me\s+/i, '').replace(ENGLISH_WHEN, '').replace(ENGLISH_CLOCK, '');
    return /^(?:to |not to |about )\w/i.test(action);
  }
  return REMINDER_REQUESTS.some(pattern => pattern.test(request));
}

// STT can omit the comma before a correction or a question about the wording.
const ASKS_MEANING = /(?:^|[\s,;:])[çc]a (?:veut dire quoi|signifie quoi)(?: au juste| exactement)?\s*[.?!…]*$/i;
const CLAUSE_BREAK = /[,;.!?…]+|\s+(?:mais|pis|puis|euh|but|(?:ah|ben)(?=\s+non\b))\s+|\s+(?=non\s+(?:laisse|oublie)\b)/i;
const NON_ACTION_CLAUSES = [
  /^(?:non\b|laisse (?:faire|tomber)\b|oublie ça\b|never ?mind\b|forget it\b)/i,
  /^(?:ne )?(?:me )?(?:la |le |les )?(?:garde|note|retiens|enregistre|rappelle)(?:[- ](?:la|le|les|ça|moi))? (?:surtout )?(?:pas|plus|pu|jamais)\b/i,
  /^(?:je (?:ne )?|j')veux (?:pas|plus|pu) que tu (?:la |le |les )?(?:gardes?|notes?|retiennes|enregistres?)\b/i,
  /^(?:(?:je (?:ne )?|j')veux|tu (?:ne )?vas) (?:pas|plus|pu) (?:la |le |les |l')?(?:garder|noter|retenir|enregistrer|écrire)\b/i,
  /^(?:do not|don't) (?:save|keep|write down|remember|remind)\b/i,
  /^(?:garde(?:[- ](?:la|le|les|ça))? (?:juste |seulement )?pour toi|keep (?:this|it) (?:just )?to yourself)\b/i,
  /^(?:n'en parle|en parle|parle[- ]en|(?:ne )?(?:le |la )?dis|dis[- ](?:le|la)) (?:surtout )?(?:pas|jamais|rien)\b/i,
  /^(?:dit|disait|a dit|said|says) (?:le|la|un|une|mon|ma|the|my)\b/i
];
const MAX_PROFILES = 8;
const MAX_CHORES = 5;
const MAX_CHARACTERS = 1500;

function directFamilyRequest(text) {
  const value = String(text || '').normalize('NFC').replace(/[’‘]/g, "'").replace(/[‑‐]/g, '-').trim();
  if (ASKS_MEANING.test(value)) return '';
  const laterClauses = value.split(CLAUSE_BREAK).slice(1);
  for (const part of laterClauses) {
    const clause = part.trim().replace(/^(?:(?:euh|ah|ben|finalement|mais|surtout) )+/i, '');
    if (NON_ACTION_CLAUSES.some(pattern => pattern.test(clause))) return '';
  }
  const addressed = value.replace(SPOKEN_OPENING, '');
  if (!POLITE_REQUEST.test(addressed)) return addressed;
  const command = addressed.replace(POLITE_REQUEST, '').replace(SPOKEN_OPENING, '');
  return command.replace(/^(?:me (?:rappeler|rappelles|faire penser)|\p{L}+)(?!\p{L})/iu,
    verb => REQUEST_VERBS.get(verb.toLowerCase()) || verb);
}

// The model chooses the action. Apply the existing withdrawal/correction
// check to the later clauses and its existing veto to the opening request.
function inboxCaptureAllowed(text) {
  const request = directFamilyRequest(text);
  return Boolean(request) && !NON_ACTION_CLAUSES.some(pattern => pattern.test(request));
}

function captureKind(request) {
  if (asksForReminder(request)) return 'reminder';
  if (IDEA_REQUESTS.some(pattern => pattern.test(request))) return 'idea';
  return null;
}

function familyCaptureKind(text) {
  return captureKind(directFamilyRequest(text));
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

async function readChoreRooms(familyTasks, limit) {
  const { profiles } = await familyTasks.listProfiles();
  const rooms = [];
  for (const profile of profiles.slice(0, limit)) {
    const { room } = await familyTasks.room({ profileId: profile.id });
    rooms.push({ profile, room });
  }
  return rooms;
}

async function readPublishedPlants(plants) {
  const result = await plants.list({ view: 'child' });
  if (!Array.isArray(result?.plants)) throw new Error('Published plant cards unavailable');
  return result.plants;
}

// The same rows the Kids Room shows. A failure leaves the turn without the
// summary instead of failing it; Nestor then says it does not have the list.
async function choreSummary(familyTasks, { logger } = {}) {
  try {
    const rooms = await readChoreRooms(familyTasks, MAX_PROFILES);
    if (!rooms.length) return '';
    const lines = rooms.map(({ profile, room }) => profileLine(profile, room));
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
    const rows = await readPublishedPlants(plants);
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

// How Nestor sounds with children (#121). Famille keeps the Nestor
// personality, whose adult temperament (a dry-witted majordomo) read flat to a
// child; this replaces that temperament in family conversations only. It is
// presentation: accuracy and every safety rule still come first.
const FAMILY_TONE = [
  'Parle en français québécois naturel, chaleureux et clair, avec le tutoiement et une orthographe standard pour la voix. En anglais si la personne le choisit. Pas de caricature, de ton de majordome ni de discours formel.',
  'This replaces the selected personality\'s adult temperament in family conversations.',
  'Réponds directement en une ou deux phrases pour une demande simple. Développe pour une histoire, une explication demandée ou la sécurité. Pas de boîte ou livre magique ni de comparaison enfantine automatique.',
  'Comprends les tournures québécoises et les hésitations. Si un mot incertain change le geste demandé ou sa cible, demande à l’enfant de préciser ce mot avant de choisir un outil. Réponds directement quand le sens est clair.',
  'Show real interest in the question instead of generic praise such as "Great question".',
  'Une réponse complète peut se terminer naturellement, sans nouvelle question ni offre de rappel systématique. Ne promets ni lecture, ouverture, enregistrement ou rappel sans le résultat correspondant. Un son du catalogue disponible peut être joué; un son absent est simplement annoncé indisponible, sans promesse de mise en file.',
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
async function familyTurn({ userText, notes, noteOrigin, familyTasks, detectMemoryRequest, logger, ideaInbox = defaultIdeaInbox, captureByTool = false, withChores = true, plants = null }) {
  const result = { savedNow: false, captured: null, chores: '', plants: '' };
  const request = directFamilyRequest(userText);
  const kind = captureByTool ? null : captureKind(request);
  if (kind) {
    try {
      await ideaInbox.captureIdea({ text: userText, origin: 'family', kind });
      result.captured = kind;
    } catch (error) {
      logger?.error?.('Family idea capture failed', { error: error.message });
      result.captured = 'failed';
    }
  } else if (request && detectMemoryRequest(request, { direct: true })
      && (!captureByTool || inboxCaptureAllowed(userText) && !captureKind(request))) {
    // Keep the separate explicit-note route. Its overlapping "note mon idée"
    // phrasing still belongs to the parent inbox even if the model skips it.
    try {
      await notes.record({ topic: 'general', text: userText, type: 'fact', ...noteOrigin });
      result.savedNow = true;
    } catch (error) {
      logger?.error?.('Household memory save failed', { error: error.message });
      result.captured = 'note-unconfirmed';
    }
  }
  if (withChores) {
    result.chores = await choreSummary(familyTasks, { logger });
    result.plants = await plantSummary(plants, { logger });
  }
  return result;
}

// Sentences Nestor may say only because the capture actually happened.
function capturedPrompt(captured) {
  if (captured === 'note-unconfirmed') return ' The family note could not be confirmed. Tell the child briefly that you could not confirm saving it.';
  if (captured === 'failed') return ' The child asked to keep an idea or reminder but it could not be saved; say so plainly and suggest telling Dad directly.';
  if (!captured) return '';
  return ` The child asked to keep ${captured === 'reminder' ? 'a reminder' : 'an idea'} and it has been saved in the parent review inbox. Confirm only that it was saved for Dad to review. No notification or scheduled alarm is confirmed.`;
}

const FAMILY_SURFACE_CONTRACT = 'This is a family learning conversation. Use the child’s latest language, defaulting to Canadian French only when unclear. Keep private adult data separate. Household handles speech and supplies the current approved context; native permissions define your tools. ' + FAMILY_TONE;

module.exports = { FAMILY_SURFACE_CONTRACT, FAMILY_TONE, capturedPrompt, choreSummary, familyCaptureKind, inboxCaptureAllowed, familyTurn, householdMembers, plantSummary,
  readChoreRooms, readPublishedPlants };

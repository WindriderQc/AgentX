'use strict';

// What a family conversation may know and keep beyond talking. Nestor sees a
// read-only summary of the Kids Room routines (#41) and may keep a child's idea
// or reminder for the parent to review (#13). Nothing here checks in, approves
// or completes a chore, and no personal task or code work is reachable.
const defaultIdeaInbox = require('../../src/services/ideaInboxService');
const { ageInYears, birthdayLabel, instanceToday } = require('../../src/domains/household/familyBirthDate');

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

// How Nestor sounds with children (#121). Famille keeps the Nestor
// personality, whose adult temperament (a dry-witted majordomo) read flat to a
// child; this replaces that temperament in family conversations only. It is
// presentation: accuracy and every safety rule still come first.
const FAMILY_TONE = [
  'Tone with children: playful, curious and encouraging, like a fun guide at a science museum, never a dry or formal butler.',
  'This replaces the selected personality\'s adult temperament in family conversations.',
  'Answer first, in simple words. When it helps, add one vivid comparison, a surprising fact or a tiny game the child can try.',
  'Show real interest in the question instead of generic praise such as "Great question".',
  'End with a short invitation to wonder further or to ask the next question.',
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
async function familyTurn({ userText, notes, familyTasks, detectMemoryRequest, logger, ideaInbox = defaultIdeaInbox, withChores = true }) {
  const result = { savedNow: false, captured: null, chores: '' };
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
  if (withChores) result.chores = await choreSummary(familyTasks, { logger });
  return result;
}

// Sentences Nestor may say only because the capture actually happened.
function capturedPrompt(captured) {
  if (captured === 'failed') return ' The child asked to keep an idea or reminder but it could not be saved; say so plainly and suggest telling Dad directly.';
  if (!captured) return '';
  return ` The child asked to keep ${captured === 'reminder' ? 'a reminder' : 'an idea'} and it has been saved for Dad to review; confirm plainly that Dad will see it, without promising that he will act on it.`;
}

module.exports = { FAMILY_TONE, capturedPrompt, choreSummary, familyCaptureKind, familyTurn, householdMembers };

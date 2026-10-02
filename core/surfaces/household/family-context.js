'use strict';

// What a family conversation may know and keep beyond talking. Nestor sees a
// read-only summary of the Kids Room routines (#41) and may keep a child's idea
// or reminder for the parent to review (#13). Nothing here checks in, approves
// or completes a chore, and no personal task or code work is reachable.
const defaultIdeaInbox = require('../../src/services/ideaInboxService');

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

module.exports = { capturedPrompt, choreSummary, familyCaptureKind, familyTurn };

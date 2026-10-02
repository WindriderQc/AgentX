'use strict';

const { dadDesk } = require('./briefing');

function item(id, label, status, detail, href) {
  return { id, label, status, detail, href };
}

function householdActivation(input = {}, now = new Date()) {
  const cron = input.cron || {};
  const familyInput = input.family || {};
  const knowledge = input.knowledge || {};
  const device = input.device || {};
  const desk = dadDesk({ unavailable: true }, [], cron, now, familyInput);
  const family = desk.family;
  const reminder = desk.reminder;
  const sourceUnavailable = input.unavailable === true || Boolean(input.error);

  const items = [
    item(
      'family',
      'Family profiles & routines',
      family.status === 'ready' ? 'ready' : family.status === 'review' ? 'attention' : 'waiting',
      family.summary,
      '/lecture/parents'
    ),
    item(
      'reminder',
      'Consent-first morning reminder',
      reminder.status === 'active' ? 'ready' : ['attention', 'missing', 'unavailable'].includes(reminder.status) ? 'attention' : 'waiting',
      reminder.summary,
      reminder.href
    ),
    item(
      'knowledge',
      'Parent-approved Nestor knowledge',
      knowledge.enabled === true && Number(knowledge.documentCount) > 0 ? 'ready' : 'waiting',
      knowledge.enabled === true
        ? `${Math.max(0, Number(knowledge.documentCount) || 0)} approved document${Number(knowledge.documentCount) === 1 ? '' : 's'} available.`
        : 'Retrieval stays off until Dad approves an exact family corpus.',
      '/dad/day#knowledge'
    ),
    item(
      'device',
      'Surface Phase 0 acceptance',
      device.status === 'phase0_passed' ? 'ready' : 'waiting',
      device.status === 'phase0_passed'
        ? 'The complete physical device receipt is recorded.'
        : 'A real Surface mic, speaker, touch, recovery, and kiosk run is still required.',
      '/device-check'
    ),
    item(
      'wake-word',
      'Native wake gate',
      'ready',
      'Local VoiX VAD and Whisper now reject non-addressed room speech before any visible text, memory, AgentX, or TTS. Surface integration remains outside Phase 0.',
      '/voice'
    )
  ];
  if (sourceUnavailable) {
    return {
      status: 'unavailable',
      pendingGates: 0,
      attentionGates: 1,
      items: [],
      error: String(input.error || 'Household activation evidence is unavailable').slice(0, 240),
      authority: 'Household stores + official OpenClaw cron evidence'
    };
  }
  const pendingGates = items.filter((entry) => entry.status === 'waiting').length;
  const attentionGates = items.filter((entry) => entry.status === 'attention').length;
  return {
    status: attentionGates ? 'attention' : pendingGates ? 'waiting' : 'ready',
    pendingGates,
    attentionGates,
    items,
    authority: 'Household stores + official OpenClaw cron evidence'
  };
}

module.exports = { householdActivation };

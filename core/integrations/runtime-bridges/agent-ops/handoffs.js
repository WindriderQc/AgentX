'use strict';

// The instance owns the agent runtime's entry format; Core only relays it to
// the Team guide. Anything malformed is dropped rather than half-shown.
const NEW_MEMBER_TEMPLATE_PATH = 'config/agent-ops-new-member.json';
function parseNewMemberTemplate(text) {
  try {
    if (String(text).length > 16384) return null;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || !value.entry || typeof value.entry !== 'object' || Array.isArray(value.entry)) return null;
    const short = (item, max) => (typeof item === 'string' ? item.trim().slice(0, max) : '');
    return {
      runtime: short(value.runtime, 60),
      entryPath: short(value.entryPath, 120),
      entry: value.entry,
      notes: (Array.isArray(value.notes) ? value.notes : []).map((note) => short(note, 300)).filter(Boolean).slice(0, 5),
    };
  } catch {
    return null;
  }
}

// Where Agent Ops sends the user next: the native runtime surfaces, the new
// member template, and the AgentX pages that complement them.
function buildHandoffs(openclawStatus, newMemberInput) {
  return {
    openclaw: {
      status: openclawStatus,
      capabilities: [
        { label: 'Overview', path: '/overview', icon: 'fa-gauge-high' },
        { label: 'Agents', path: '/agents', icon: 'fa-users-gear' },
        { label: 'Sessions', path: '/sessions', icon: 'fa-clock-rotate-left' },
        { label: 'Automations', path: '/cron', icon: 'fa-calendar-days' },
      ],
    },
    newMember: newMemberInput?.ok ? parseNewMemberTemplate(newMemberInput.value) : null,
    agentx: {
      complements: [
        { label: 'Nerve Center', href: '/nerve-center', icon: 'fa-brain', reason: 'Machine, model, and routing health.' },
        { label: 'AgentX Pipeline', href: '/pipeline', icon: 'fa-list-check', reason: 'Coding work, ownership, progress, and feedback.' },
        { label: 'Memory Review', href: '/memory-review', icon: 'fa-book-open', reason: 'Approval-first memory evidence.' },
      ],
    },
  };
}

module.exports = { NEW_MEMBER_TEMPLATE_PATH, buildHandoffs, parseNewMemberTemplate };
